import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import {
  OmnetppMethods,
  type Position as Pos,
  type PreviewScene,
  type Range,
} from '@omnetpp/shared/protocol';

/**
 * The graphical NED preview: a singleton editor-area webview panel (opened
 * Beside, like the Markdown preview) that renders the type under the cursor
 * the way the Eclipse IDE's graphical NED editor does. Follows the cursor
 * with the same debounce pattern as the tree views; a title-bar pin fixes it
 * on the current type. The webview app itself is bundled separately
 * (dist/webview/nedPreview.js); this host resolves scenes over the
 * omnetpp/nedPreview request and icon ids to webview URIs.
 */

const NED_LANG = 'OMNeT++ NED';
const VIEW_TYPE = 'omnetpp.nedPreview';
const PIN_KEY = 'omnetpp.preview.pinnedFqName';

/** Fallback scale (percent) when a sized icon variant file does not exist. */
const SIZE_SCALE: Record<string, number> = { vs: 40, s: 60, l: 150, vl: 250 };

/** What the webview needs to know about one resolved icon. */
interface IconAsset {
  uri: string;
  /** Natural pixel size, when known without loading (bundled index.json). */
  size?: [number, number];
  /** Post-load scaling percent when a size variant fell back to the base file. */
  scalePct?: number;
}

type HostMessage =
  | { type: 'ready' }
  | { type: 'navigate'; uri: string; range?: Range }
  | { type: 'openType'; uri: string; range?: Range }
  | { type: 'export'; format: 'svg' | 'png'; data: string; suggestedName: string }
  | { type: 'setPin'; fqName?: string }
  | { type: 'drillIn'; fqName: string }
  | { type: 'historyBack' }
  | { type: 'historyForward' };

function activeNedContext(): { uri: string; position: Pos } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== NED_LANG) return undefined;
  const p = ed.selection.active;
  return { uri: ed.document.uri.toString(), position: { line: p.line, character: p.character } };
}

async function revealLocation(uri: string, range?: Range, preserveFocus = false): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus, viewColumn: vscode.ViewColumn.One });
  if (range) {
    const r = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
    editor.selection = new vscode.Selection(r.start, r.start);
    editor.revealRange(r, vscode.TextEditorRevealType.InCenter);
  }
}

export class NedPreviewPanel {
  static current: NedPreviewPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private lastTypeListKey?: string;
  private lastSceneKey?: string;
  private bundledIndex?: Record<string, [number, number]>;

  /**
   * Navigation history of deliberate pins (drill-in, search, pin/clear), for
   * back/forward. Each entry is a pinned fq-name or `undefined` (unpinned /
   * follow-cursor). Cursor movement in unpinned mode does NOT push history.
   */
  private history: string[] = [];
  private historyIndex = -1;
  /** fq-name of the type currently shown (pinned or under the cursor), if any. */
  private currentFqName?: string;

  static createOrShow(context: vscode.ExtensionContext, client: LanguageClient): void {
    if (NedPreviewPanel.current) {
      NedPreviewPanel.current.panel.reveal(undefined, true);
      void NedPreviewPanel.current.update(true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'NED Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      NedPreviewPanel.webviewOptions(context),
    );
    NedPreviewPanel.current = new NedPreviewPanel(panel, context, client);
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, client: LanguageClient): void {
    panel.webview.options = NedPreviewPanel.webviewOptions(context);
    NedPreviewPanel.current = new NedPreviewPanel(panel, context, client);
  }

  /** Webview options; recomputed on revive so localResourceRoots follow settings. */
  private static webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'dist')];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    const installDir = vscode.workspace.getConfiguration('omnetpp').get<string>('installDir', '');
    if (installDir) roots.push(vscode.Uri.file(installDir));
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: roots,
    };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly client: LanguageClient,
  ) {
    // seed history from the persisted pin, if any (unpinned ⇒ index -1)
    const pin = this.pinnedFqName();
    this.history = pin ? [pin] : [];
    this.historyIndex = pin ? 0 : -1;
    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: HostMessage) => void this.onMessage(m), null, this.disposables);

    // follow the cursor with the same debounce pattern as the tree views
    let timer: NodeJS.Timeout | undefined;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.update(), 300);
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this.update()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.languageId === NED_LANG) debounced();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === NED_LANG) this.invalidateAndUpdate(debounced);
      }),
    );
  }

  /** Text edits change content under the same focus key: force a re-render. */
  private invalidateAndUpdate(debounced: () => void): void {
    this.lastSceneKey = undefined;
    debounced();
  }

  private dispose(): void {
    NedPreviewPanel.current = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  // ---- pinning (driven by the webview's search box / pin button) ----

  pinnedFqName(): string | undefined {
    return this.context.workspaceState.get<string>(PIN_KEY);
  }

  /** Forward a context-menu command (re-layout, export) to the webview app. */
  sendCommand(command: 'relayout' | 'exportSvg' | 'exportPng'): void {
    void this.panel.webview.postMessage({ type: 'command', command });
  }

  /**
   * Drill into a type (the "Show" context-menu item / Ctrl-click). If the
   * preview was following the cursor, the type currently shown is recorded
   * first, so Back returns to where the user started exploring from. This
   * pins the preview — intended, since the user is now navigating by drill-in
   * and back/forward; a later unpin resumes cursor-following.
   */
  async showType(fqName: string): Promise<void> {
    if (this.historyIndex < 0 && this.currentFqName && this.currentFqName !== fqName) {
      this.history = [this.currentFqName];
      this.historyIndex = 0;
    }
    await this.navigateTo(fqName);
  }

  // ---- navigation history (back/forward) ----
  // The history holds ONLY existing, pinned NED types. The unpinned
  // (follow-cursor) state is not an entry — it is the position *before* the
  // first entry, represented by historyIndex === -1.

  /**
   * Record a deliberate navigation to an existing type and apply it: drop any
   * forward history, push the type, and pin to it. A no-op when it is already
   * the current entry so a stray re-pin doesn't create a dead history entry.
   */
  private async navigateTo(fqName: string): Promise<void> {
    if (this.historyIndex >= 0 && this.history[this.historyIndex] === fqName) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(fqName);
    this.historyIndex = this.history.length - 1;
    await this.applyPin(fqName);
  }

  /** Clear the pin (resume cursor-following) — the unpinned position (-1). */
  private async clearPin(): Promise<void> {
    this.historyIndex = -1;
    await this.applyPin(undefined);
  }

  private async applyPin(fqName: string | undefined): Promise<void> {
    await this.context.workspaceState.update(PIN_KEY, fqName);
    await this.update(true);
  }

  async back(): Promise<void> {
    if (this.historyIndex <= 0) return; // stop at the first pinned type
    this.historyIndex--;
    await this.applyPin(this.history[this.historyIndex]);
  }

  async forward(): Promise<void> {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    await this.applyPin(this.history[this.historyIndex]);
  }

  /** Tell the webview whether the back/forward toolbar buttons are enabled. */
  private postHistory(): void {
    void this.panel.webview.postMessage({
      type: 'history',
      canGoBack: this.historyIndex > 0,
      canGoForward: this.historyIndex < this.history.length - 1,
    });
  }

  // ---- scene updates ----

  private async fetchScene(): Promise<PreviewScene | null> {
    const pinned = this.pinnedFqName();
    const params = pinned ? { fqName: pinned } : activeNedContext();
    if (!params) return null;
    try {
      return await this.client.sendRequest<PreviewScene | null>(OmnetppMethods.nedPreview, params);
    } catch {
      return null;
    }
  }

  async update(force = false): Promise<void> {
    if (!this.webviewReady) return;
    this.postHistory();
    const scene = await this.fetchScene();
    // without a NED editor (or on request failure) keep showing the last scene
    if (!scene && !force) return;
    this.currentFqName = scene?.fqName;

    const key = scene ? JSON.stringify(scene) : 'empty';
    if (force || key !== this.lastSceneKey) {
      this.lastSceneKey = key;
      const icons = scene ? this.resolveIcons(scene) : {};
      this.panel.title = scene ? `NED Preview: ${scene.simpleName}` : 'NED Preview';
      void this.panel.webview.postMessage({
        type: 'scene',
        scene,
        icons,
        pinned: !!this.pinnedFqName(),
        pinnedFqName: this.pinnedFqName(),
      });
    }
    void this.postTypeList();
  }

  /** Feed the search box's completion list (all indexed NED type fq-names). */
  private async postTypeList(): Promise<void> {
    let types: string[] = [];
    try {
      const result = await this.client.sendRequest<{ fqName: string }[]>(OmnetppMethods.mcpCallTool, {
        name: 'list_ned_types',
        arguments: {},
      });
      types = result.map((t) => t.fqName).sort();
    } catch {
      return;
    }
    const listKey = `${types.length}|${types[0] ?? ''}|${types[types.length - 1] ?? ''}`;
    if (listKey === this.lastTypeListKey) return;
    this.lastTypeListKey = listKey;
    void this.panel.webview.postMessage({ type: 'typeList', types });
  }

  /**
   * Pin request from the search box: empty input clears the pin; otherwise the
   * loose input is resolved to an *existing* NED type before pinning. A name
   * that resolves to no indexed type is ignored, so the history only ever holds
   * real pinned types.
   */
  private async setPinFromSearch(text: string | undefined): Promise<void> {
    const raw = text?.trim();
    if (!raw) {
      await this.clearPin();
      return;
    }
    const fqName = await this.resolveKnownType(raw);
    if (fqName) await this.navigateTo(fqName);
  }

  /** Resolve loose input to an indexed NED type's fq-name (exact, else unique
   *  simple-name match); undefined if no such type exists. */
  private async resolveKnownType(text: string): Promise<string | undefined> {
    let types: { fqName: string }[];
    try {
      types = await this.client.sendRequest<{ fqName: string }[]>(OmnetppMethods.mcpCallTool, {
        name: 'list_ned_types',
        arguments: {},
      });
    } catch {
      return text; // index unavailable: best-effort pin verbatim
    }
    if (types.some((t) => t.fqName === text)) return text; // exact fq-name
    const needle = text.toLowerCase();
    const matches = types.filter((t) => (t.fqName.split('.').pop() ?? t.fqName).toLowerCase() === needle);
    return matches.length >= 1 ? matches[0].fqName : undefined;
  }

  // ---- icon resolution (Eclipse search order) ----

  /** Ordered icon search roots: project images/ dirs → installDir/images → bundled. */
  private iconRoots(): { dir: string; bundled: boolean }[] {
    const roots: { dir: string; bundled: boolean }[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme === 'file') roots.push({ dir: path.join(f.uri.fsPath, 'images'), bundled: false });
    }
    const installDir = vscode.workspace.getConfiguration('omnetpp').get<string>('installDir', '');
    if (installDir) roots.push({ dir: path.join(installDir, 'images'), bundled: false });
    roots.push({ dir: path.join(this.context.extensionUri.fsPath, 'dist', 'icons'), bundled: true });
    return roots;
  }

  private loadBundledIndex(): Record<string, [number, number]> {
    if (!this.bundledIndex) {
      try {
        const p = path.join(this.context.extensionUri.fsPath, 'dist', 'icons', 'index.json');
        this.bundledIndex = (JSON.parse(fs.readFileSync(p, 'utf8')) as { icons: Record<string, [number, number]> }).icons;
      } catch {
        this.bundledIndex = {};
      }
    }
    return this.bundledIndex;
  }

  /** Find an icon id in the search roots (tries .png then .gif, like the IDE). */
  private findIconFile(id: string): { file: string; bundled: boolean } | undefined {
    if (id.includes('..')) return undefined; // display strings must not escape the roots
    for (const root of this.iconRoots()) {
      for (const ext of ['.png', '.gif']) {
        const file = path.join(root.dir, id + ext);
        if (fs.existsSync(file)) return { file, bundled: root.bundled };
      }
    }
    return undefined;
  }

  /**
   * Resolve every icon the scene references to a webview URI. A sized variant
   * (`is=` tag) first looks for a `name_<size>` file everywhere; if only the
   * base file exists, the webview scales it by the Eclipse percentages.
   */
  private resolveIcons(scene: PreviewScene): Record<string, IconAsset> {
    const out: Record<string, IconAsset> = {};
    const index = this.loadBundledIndex();

    const resolveOne = (id: string, sizeSuffix?: string): IconAsset | undefined => {
      const candidates = sizeSuffix ? [`${id}_${sizeSuffix}`, id] : [id];
      for (const candidate of candidates) {
        const hit = this.findIconFile(candidate);
        if (!hit) continue;
        const asset: IconAsset = { uri: this.panel.webview.asWebviewUri(vscode.Uri.file(hit.file)).toString() };
        if (hit.bundled && index[candidate]) asset.size = index[candidate];
        if (candidate === id && sizeSuffix) asset.scalePct = SIZE_SCALE[sizeSuffix];
        return asset;
      }
      return undefined;
    };

    for (const icon of [...scene.icons, { id: '_internal/default' }, { id: '_internal/unknown' }] as {
      id: string;
      sizeSuffix?: string;
    }[]) {
      const key = `${icon.id}|${icon.sizeSuffix ?? ''}`;
      const asset = resolveOne(icon.id, icon.sizeSuffix) ?? resolveOne('_internal/unknown');
      if (asset) out[key] = asset;
    }
    return out;
  }

  // ---- webview messages ----

  private async onMessage(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        void this.update(true);
        break;
      case 'navigate':
        await revealLocation(msg.uri, msg.range, true);
        break;
      case 'openType':
        await revealLocation(msg.uri, msg.range);
        break;
      case 'setPin':
        await this.setPinFromSearch(msg.fqName);
        break;
      case 'drillIn':
        await this.showType(msg.fqName);
        break;
      case 'historyBack':
        await this.back();
        break;
      case 'historyForward':
        await this.forward();
        break;
      case 'export': {
        const filters: Record<string, string[]> =
          msg.format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] };
        const target = await vscode.window.showSaveDialog({
          filters,
          defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', msg.suggestedName)),
        });
        if (!target) return;
        const bytes = msg.format === 'svg' ? Buffer.from(msg.data, 'utf8') : Buffer.from(msg.data, 'base64');
        await vscode.workspace.fs.writeFile(target, bytes);
        void vscode.window.showInformationMessage(`OMNeT++: preview exported to ${target.fsPath}`);
        break;
      }
    }
  }

  // ---- html ----

  private buildHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'nedPreview.js'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    // connect-src allows the webview to fetch() icon bytes for canvas tinting
    // (drawing a cross-origin <img> would taint the canvas).
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NED Preview</title>
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  /* The whole page stylesheet lives here (not injected from the webview
     script): style-src carries a nonce, so a JS-appended <style> without one
     would be blocked — 'unsafe-inline' is ignored when a nonce is present. */
  #root { display: flex; flex-direction: column; height: 100%; font-family: var(--vscode-font-family); }
  #toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 4px 8px;
             background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
             border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  #toolbar button { display: flex; align-items: center; justify-content: center;
             width: 24px; height: 20px; padding: 0;
             background: var(--vscode-button-secondaryBackground, #ddd);
             color: var(--vscode-button-secondaryForeground, #333); border: none; border-radius: 2px;
             cursor: pointer; font-size: 12px; }
  #toolbar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #ccc); }
  #toolbar button:disabled { opacity: 0.4; cursor: default; }
  #toolbar button svg { display: block; }
  #zoomLabel { min-width: 42px; text-align: center; font-size: 12px; }
  #typeSearch { margin-left: auto; flex: 0 1 280px; min-width: 90px; height: 20px; box-sizing: border-box;
             background: var(--vscode-input-background, #fff); color: var(--vscode-input-foreground, #333);
             border: 1px solid var(--vscode-input-border, #0000); border-radius: 2px;
             padding: 0 6px; font-size: 12px; font-family: var(--vscode-font-family); }
  #typeSearch::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
  /* Qtenv's canvas shade behind everything (colors::LIGHTGREEN in qtutil.cc) */
  #paper { flex: 1 1 auto; overflow: auto; background: #a0e0a0; position: relative;
           cursor: grab; user-select: none; }
  #paper.panning { cursor: grabbing; }
  #paper.panning * { cursor: grabbing !important; }
  #canvas { padding: 8px; width: max-content; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           color: #888; font-size: 13px; text-align: center; padding: 0 24px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Register the preview commands, editor-title button and panel serializer. */
export function registerNedPreview(context: vscode.ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.showNedPreview', () => NedPreviewPanel.createOrShow(context, client)),
    vscode.commands.registerCommand('omnetpp.previewShowType', (ctx?: { fqName?: string }) => {
      if (ctx?.fqName) void NedPreviewPanel.current?.showType(ctx.fqName);
    }),
    vscode.commands.registerCommand('omnetpp.previewBack', () => void NedPreviewPanel.current?.back()),
    vscode.commands.registerCommand('omnetpp.previewForward', () => void NedPreviewPanel.current?.forward()),
    vscode.commands.registerCommand('omnetpp.previewRelayout', () => NedPreviewPanel.current?.sendCommand('relayout')),
    vscode.commands.registerCommand('omnetpp.previewExportSvg', () => NedPreviewPanel.current?.sendCommand('exportSvg')),
    vscode.commands.registerCommand('omnetpp.previewExportPng', () => NedPreviewPanel.current?.sendCommand('exportPng')),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        NedPreviewPanel.revive(panel, context, client);
        return Promise.resolve();
      },
    }),
  );
}
