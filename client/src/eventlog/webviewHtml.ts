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
    background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
    /* Phase U9 (loose end): a narrow editor/panel can no longer fit every toolbar
       button/dropdown -- rather than silently clipping (the pre-existing behavior:
       overflow was unset, so items past the container edge were just invisible),
       let the bar scroll horizontally. Cheap CSS-only fix; a dedicated "..." overflow
       menu is not built here (not worth the added complexity for a toolbar this size). */
    overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
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
  /* CSP note: the webview CSP has no style-src-attr allowance, so inline style="..."
     attributes in webview-generated HTML are BLOCKED (this exact class replaced one
     that silently zero-heighted the chart canvas container). Style elements here (nonce'd)
     and CSSOM assignments (el.style.x = ...) are the only allowed styling vectors. */
  .elog-chart-canvas-container { position: absolute; inset: 0; overflow: hidden; }
  .elog-tooltip-msg { color: var(--vscode-charts-purple, rgb(127, 0, 85)); }
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
  /* The table's mount root (#rows, filled by tableView.ts) must fill the positioned
     .elog-body -- like .elog-chart-canvas-container above. Without a definite height here,
     .elog-table's height:100% collapses to just its header, so only one row is ever
     visible (the same zero-height class of bug the chart container's rule fixed). */
  #rows { position: absolute; inset: 0; }
  .elog-table { position: relative; height: 100%; overflow: hidden; outline: none; display: flex; flex-direction: column; }
  .elog-table-header { display: flex; flex: 0 0 auto; font-weight: bold; font-size: 11px;
    color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
    user-select: none; }
  .elog-table-header .elog-col { padding: 2px 4px; overflow: hidden; white-space: nowrap; position: relative; box-sizing: border-box; }
  .elog-col-resizer { position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; z-index: 2; }
  /* The scrolling body below the header: flex-fills the remaining height, and is the
     positioning context for the absolutely-placed virtual rows + custom scrollbar. */
  .elog-rows-viewport { position: relative; flex: 1 1 auto; overflow: hidden; }
  .elog-rows { position: absolute; left: 0; right: 14px; top: 0; bottom: 0; overflow: hidden; }
  .elog-row { display: flex; align-items: center; white-space: pre; box-sizing: border-box;
    font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }
  .elog-row .elog-col { padding: 0 4px; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
  .elog-row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  .elog-table.focused .elog-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .elog-row.focus-row { outline: 1px solid var(--vscode-list-focusOutline, transparent); outline-offset: -1px; }
  .elog-row.bookmarked { box-shadow: inset 3px 0 0 0 var(--vscode-charts-green, #89d185); }
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
  .elog-findbar-status { flex: 0 0 auto; font-size: 11px; color: var(--vscode-errorForeground, #f14c4c); min-width: 60px; }
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
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.35); font-size: 13px; user-select: none;
    /* long menus (e.g. the 25-item Show/Hide list) scroll vertically instead of overflowing the window */
    max-height: calc(100vh - 16px); overflow-y: auto; overflow-x: hidden; }
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
  .elog-dialog-row-textarea { display: block; }
  .elog-dialog-row-textarea label { display: block; margin-bottom: 4px; }
  .elog-dialog-row-textarea textarea { width: 100%; box-sizing: border-box; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 6px; font: inherit; }
  .elog-dialog-error { min-height: 16px; color: var(--vscode-errorForeground, #f14c4c); font-size: 12px; margin-bottom: 6px; }
  .elog-dialog-buttons { display: flex; justify-content: flex-end; gap: 6px; }
  .elog-dialog-buttons button { padding: 4px 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .elog-dialog-buttons button:last-child { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .elog-dialog-buttons button:disabled { opacity: 0.5; cursor: default; }
  .elog-dialog-buttons button.elog-dialog-button-remove { margin-right: auto; color: var(--vscode-errorForeground, #f14c4c); }

  /* Filter panel (phase U7, chart/filterPanel.ts) -- a collapsible right-side overlay
     over the Sequence Chart canvas ("in-webview collapsible filter panel" decision
     record), NOT a modal (unlike .elog-dialog above): it stays mounted, just
     display:none-toggled, so its own local edits (checkboxes/text fields) survive a
     close/reopen without a round trip. */
  .elog-filter-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 340px; max-width: 90%;
    z-index: 50; flex-direction: column; background: var(--vscode-editorWidget-background);
    border-left: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4));
    box-shadow: -2px 0 8px rgba(0,0,0,0.25); font-size: 12px; }
  .elog-filter-panel-header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); font-weight: bold; }
  .elog-filter-panel-close { background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
    display: flex; align-items: center; border-radius: 3px; padding: 2px; }
  .elog-filter-panel-close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .elog-filter-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 6px 8px; }
  .elog-filter-section-header { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-weight: bold; cursor: pointer; }
  .elog-filter-section-header input[type="checkbox"] { flex: 0 0 auto; }
  .elog-filter-section-detail { margin: 0 0 8px 20px; padding-left: 8px; border-left: 2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    opacity: 0.5; }
  .elog-filter-section-detail.enabled { opacity: 1; }
  .elog-filter-field-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .elog-filter-field-row label { flex: 0 0 auto; min-width: 0; }
  .elog-filter-group { margin-bottom: 6px; }
  .elog-filter-group-title { font-weight: bold; text-transform: uppercase; font-size: 10px;
    color: var(--vscode-descriptionForeground); margin: 8px 0 2px; letter-spacing: 0.4px; }
  .elog-filter-input-number { width: 90px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 2px 4px; font: inherit; }
  .elog-filter-input-text { flex: 1 1 auto; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 2px 4px; font: inherit; }
  .elog-filter-multiselect { max-height: 110px; overflow-y: auto; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    border-radius: 3px; padding: 2px 4px; }
  .elog-filter-multiselect-item { display: flex; align-items: center; gap: 6px; padding: 1px 0; cursor: pointer; }
  .elog-filter-moduletree { max-height: 160px; overflow-y: auto; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    border-radius: 3px; padding: 2px 4px; }
  .elog-filter-moduletree-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; white-space: nowrap; }
  .elog-filter-hint-empty { font-style: italic; color: var(--vscode-descriptionForeground); padding: 2px 0; }
  .elog-filter-note { font-style: italic; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .elog-filter-description { margin: 8px 0; padding: 6px 8px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    border-radius: 3px; white-space: pre-wrap; word-break: break-word; color: var(--vscode-descriptionForeground); min-height: 2.6em; }
  .elog-filter-busy { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 8px;
    padding: 4px 8px; background: var(--vscode-inputValidation-infoBackground, rgba(128,128,128,0.15)); border-radius: 3px; }
  .elog-filter-busy button { padding: 2px 8px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .elog-filter-panel-footer { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 6px; padding: 6px 8px;
    border-top: 1px solid var(--vscode-editorWidget-border, transparent); }
  .elog-filter-panel-footer button { padding: 4px 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .elog-filter-panel-footer button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .elog-filter-panel-footer button:disabled { opacity: 0.5; cursor: default; }

  /* "Bookmark Info" note boxes (chartMain.ts's note-layer refresh) -- floating DOM
     overlays positioned over the chart canvas (same pattern as the Ctrl-drag marquee),
     not canvas-drawn, so they get real text wrapping/auto-sizing/rich-HTML rendering
     for free from the browser instead of a hand-rolled canvas text-wrap algorithm. */
  .elog-bookmark-notes-layer { position: absolute; inset: 0; pointer-events: none; }
  .elog-bookmark-note { position: absolute; max-width: 220px; padding: 6px 8px; box-sizing: border-box;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    border: 1px solid var(--vscode-editorWidget-border, transparent); border-radius: 4px;
    font-size: 11px; line-height: 1.4; color: var(--vscode-foreground); pointer-events: auto;
    cursor: pointer; overflow-wrap: break-word; }
  .elog-bookmark-note:hover { border-color: var(--vscode-focusBorder, #007fd4); }
  .elog-bookmark-note-title { font-weight: bold; margin-bottom: 3px; }
  .elog-bookmark-note-body p { margin: 0 0 4px 0; }
  .elog-bookmark-note-body p:last-child { margin-bottom: 0; }
  .elog-bookmark-note-body ul, .elog-bookmark-note-body ol { margin: 0 0 4px 18px; padding: 0; }
  .elog-bookmark-note-body h1, .elog-bookmark-note-body h2 { margin: 0 0 4px 0; font-size: 12px; }
  .elog-bookmark-note-body code { background: rgba(128,128,128,0.25); padding: 0 2px; border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace); }
  .elog-bookmark-note-body a { color: var(--vscode-textLink-foreground); }

  /* Notification overlay (phase U9, common/notificationOverlay.ts) -- the shared
     canceled/out-of-sync/error screen both the chart and table mount over their own
     .elog-body. */
  .elog-notification-overlay { position: absolute; inset: 0; z-index: 70; display: none;
    flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    padding: 16px; text-align: center; background: var(--vscode-editor-background);
    color: var(--vscode-foreground); }
  .elog-notification-icon { font-size: 32px; color: var(--vscode-descriptionForeground); }
  .elog-notification-icon.codicon-error { color: var(--vscode-errorForeground, #f14c4c); }
  .elog-notification-icon.codicon-warning { color: var(--vscode-editorWarning-foreground, #cca700); }
  .elog-notification-message { max-width: 480px; font-size: 13px; }
  .elog-notification-refresh { padding: 4px 14px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .elog-notification-refresh:hover { background: var(--vscode-button-hoverBackground); }
  .elog-notification-details { max-width: 560px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .elog-notification-details pre { white-space: pre-wrap; word-break: break-word; text-align: left;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1)); padding: 6px 8px; border-radius: 3px; }

  /* High-contrast pass (phase U9): VS Code's high-contrast themes guarantee
     --vscode-contrastBorder stays visible against every other chrome color --
     strengthen borders that otherwise rely on a (possibly near-invisible-under-HC)
     widget-specific border color, and widen the chart's own keyboard focus ring. */
  body.vscode-high-contrast .elog-tooltip,
  body.vscode-high-contrast .elog-menu,
  body.vscode-high-contrast .elog-dialog,
  body.vscode-high-contrast .elog-filter-panel,
  body.vscode-high-contrast .elog-bookmark-note,
  body.vscode-high-contrast-light .elog-tooltip,
  body.vscode-high-contrast-light .elog-menu,
  body.vscode-high-contrast-light .elog-dialog,
  body.vscode-high-contrast-light .elog-filter-panel,
  body.vscode-high-contrast-light .elog-bookmark-note {
    border-color: var(--vscode-contrastBorder, currentColor) !important;
  }
  body.vscode-high-contrast #chartCanvasContainer:focus-visible,
  body.vscode-high-contrast-light #chartCanvasContainer:focus-visible {
    outline-width: 2px;
    outline-color: var(--vscode-focusBorder, #007fd4);
  }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
