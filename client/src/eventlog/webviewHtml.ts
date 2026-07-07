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
  /* Sequence Chart canvas container is the keyboard-interactive surface (phase U4:
     pan/zoom/select/navigate all happen via its keydown handler) -- a visible focus
     ring is the minimal a11y requirement for a focusable, non-native-control element. */
  #chartCanvasContainer { outline: none; }
  #chartCanvasContainer:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
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

  /* Sequence Chart hover tooltip (phase U4, chart/tooltip.ts) */
  .elog-tooltip { position: fixed; z-index: 1000; max-width: 480px; padding: 6px 8px; font-size: 12px; line-height: 1.5;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border, transparent));
    border-radius: 3px; box-shadow: 0 2px 8px rgba(0,0,0,0.35); pointer-events: none; white-space: normal; word-break: break-word; }
  .elog-tooltip pre { margin: 4px 0 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); }

  /* Context menu framework (phase U4, common/contextMenu.ts) -- reused by the Event
     Log table in a later phase per that file's header. */
  .elog-menu { position: fixed; z-index: 1000; min-width: 180px; max-width: 360px; padding: 3px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, transparent));
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.35); font-size: 13px; user-select: none; }
  .elog-menu-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  .elog-menu-item.highlighted, .elog-menu-item:hover:not(.disabled) {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
  .elog-menu-item.disabled { opacity: 0.45; cursor: default; }
  .elog-menu-check { width: 14px; flex: 0 0 auto; text-align: center; font-size: 11px; }
  .elog-menu-icon { flex: 0 0 auto; }
  .elog-menu-label { flex: 1 1 auto; }
  .elog-menu-arrow { flex: 0 0 auto; opacity: 0.7; }
  .elog-menu-separator { height: 1px; margin: 3px 4px; background: var(--vscode-menu-separatorBackground, var(--vscode-editorWidget-border, rgba(128,128,128,0.4))); }

  /* Goto/Find dialogs (phase U4, common/dialogs.ts) */
  .elog-dialog-overlay { position: fixed; inset: 0; z-index: 1001; background: rgba(0,0,0,0.25);
    display: flex; align-items: flex-start; justify-content: center; padding-top: 15vh; }
  .elog-dialog { min-width: 320px; max-width: 480px; padding: 12px 14px;
    background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWidget-border, transparent); border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4); font-size: 13px; }
  .elog-dialog-title { font-weight: bold; margin-bottom: 8px; }
  .elog-dialog-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .elog-dialog-row label { flex: 1 1 auto; }
  .elog-dialog-row input[type="text"] { flex: 1 1 auto; min-width: 160px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 3px 6px; font: inherit; }
  .elog-dialog-row input[type="checkbox"] { flex: 0 0 auto; }
  .elog-dialog-error { min-height: 16px; color: var(--vscode-errorForeground, #f14c4c); font-size: 12px; margin-bottom: 6px; }
  .elog-dialog-buttons { display: flex; justify-content: flex-end; gap: 6px; }
  .elog-dialog-buttons button { padding: 4px 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .elog-dialog-buttons button:last-child { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .elog-dialog-buttons button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
