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

  /* Event Log table (phase U2) -- a custom approximate scrollbar replaces the native
     one (millions of filtered rows make an exact native scrollbar range infeasible),
     so .elog-table itself never scrolls natively. */
  .elog-table { position: relative; height: 100%; overflow: hidden; outline: none; }
  .elog-table-header { display: flex; flex: 0 0 auto; font-weight: bold; font-size: 11px;
    color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
    user-select: none; }
  .elog-table-header .elog-col { padding: 2px 4px; overflow: hidden; white-space: nowrap; position: relative; box-sizing: border-box; }
  .elog-col-resizer { position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; z-index: 2; }
  .elog-rows { position: absolute; left: 0; right: 14px; top: 0; bottom: 0; overflow: hidden; }
  .elog-row { display: flex; align-items: center; white-space: pre; box-sizing: border-box;
    font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }
  .elog-row .elog-col { padding: 0 4px; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
  .elog-row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  .elog-table.focused .elog-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .elog-row.focus-row { outline: 1px solid var(--vscode-list-focusOutline, transparent); outline-offset: -1px; }
  .elog-span-const { color: var(--vscode-foreground); }
  .elog-span-constBold { color: var(--vscode-foreground); font-weight: bold; }
  .elog-span-raw, .elog-span-type, .elog-span-data { color: var(--vscode-charts-blue, #4daafc); }
  .elog-span-name { color: var(--vscode-charts-blue, #4daafc); font-weight: bold; }
  .elog-span-msg { color: var(--vscode-charts-purple, #b180d7); }
  .elog-span-bubble { color: var(--vscode-charts-red, #f14c4c); font-weight: bold; }
  .elog-span-faint { color: var(--vscode-descriptionForeground); }
  .elog-span-eventNo, .elog-span-simtime { color: var(--vscode-foreground); }
  .elog-scrollbar { position: absolute; top: 0; right: 0; width: 14px; bottom: 0; }
  .elog-scrollbar-thumb { position: absolute; left: 2px; right: 2px; background: var(--vscode-scrollbarSlider-background); border-radius: 2px; cursor: default; min-height: 16px; }
  .elog-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
  .elog-findbar { display: none; flex: 0 0 auto; align-items: center; gap: 4px; padding: 2px 6px;
    background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .elog-findbar.open { display: flex; }
  .elog-findbar input { flex: 1 1 auto; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 2px 4px; font: inherit; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
