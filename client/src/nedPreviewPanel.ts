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
  | { type: 'export'; format: 'svg' | 'png'; data: string; suggestedName: string };

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
  private lastSceneKey?: string;
  private bundledIndex?: Record<string, [number, number]>;

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
    this.syncPinContext();
  }

  /** Text edits change content under the same focus key: force a re-render. */
  private invalidateAndUpdate(debounced: () => void): void {
    this.lastSceneKey = undefined;
    debounced();
  }

  private dispose(): void {
    NedPreviewPanel.current = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
    void vscode.commands.executeCommand('setContext', 'omnetpp.previewPinned', false);
  }

  // ---- pinning ----

  pinnedFqName(): string | undefined {
    return this.context.workspaceState.get<string>(PIN_KEY);
  }

  async pin(): Promise<void> {
    const scene = await this.fetchScene();
    if (!scene) {
      void vscode.window.showInformationMessage('OMNeT++: no NED type to pin the preview on.');
      return;
    }
    await this.context.workspaceState.update(PIN_KEY, scene.fqName);
    this.syncPinContext();
    void this.update(true);
  }

  async unpin(): Promise<void> {
    await this.context.workspaceState.update(PIN_KEY, undefined);
    this.syncPinContext();
    void this.update(true);
  }

  private syncPinContext(): void {
    void vscode.commands.executeCommand('setContext', 'omnetpp.previewPinned', !!this.pinnedFqName());
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
    const scene = await this.fetchScene();
    // without a NED editor (or on request failure) keep showing the last scene
    if (!scene && !force) return;

    const key = scene ? JSON.stringify(scene) : 'empty';
    if (!force && key === this.lastSceneKey) return;
    this.lastSceneKey = key;

    const icons = scene ? this.resolveIcons(scene) : {};
    this.panel.title = scene ? `NED Preview: ${scene.simpleName}` : 'NED Preview';
    void this.panel.webview.postMessage({
      type: 'scene',
      scene,
      icons,
      pinned: !!this.pinnedFqName(),
    });
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
  #toolbar button { background: var(--vscode-button-secondaryBackground, #ddd);
             color: var(--vscode-button-secondaryForeground, #333); border: none; border-radius: 2px;
             padding: 2px 8px; cursor: pointer; font-size: 12px; }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #ccc); }
  #toolbar .sep { width: 1px; height: 16px; background: var(--vscode-editorWidget-border, #888); margin: 0 4px; }
  #zoomLabel { min-width: 42px; text-align: center; font-size: 12px; }
  #pinState { margin-left: auto; font-size: 12px; opacity: .8; }
  #paper { flex: 1 1 auto; overflow: auto; background: #ffffff; position: relative;
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
    vscode.commands.registerCommand('omnetpp.pinPreview', () => void NedPreviewPanel.current?.pin()),
    vscode.commands.registerCommand('omnetpp.unpinPreview', () => void NedPreviewPanel.current?.unpin()),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        NedPreviewPanel.revive(panel, context, client);
        return Promise.resolve();
      },
    }),
  );
}
