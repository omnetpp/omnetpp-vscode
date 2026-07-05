// Entry point of the NED preview webview (bundled to dist/webview/nedPreview.js
// as a browser IIFE). Placeholder until the renderer lands: acknowledges the
// host and shows which scene it received.
import type { PreviewScene } from '@omnetpp/shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; scene?: PreviewScene | null };
  if (msg.type === 'scene') {
    const root = document.getElementById('root')!;
    root.textContent = msg.scene ? `Scene: ${msg.scene.fqName} (${msg.scene.kind})` : 'No NED type at the cursor.';
  }
});

vscode.postMessage({ type: 'ready' });
