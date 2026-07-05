import type { PreviewScene, Range } from '@omnetpp/shared/protocol';
import { IconStore, type IconAsset } from './icons';
import { buildCardFigure, buildDiagram } from './figures';
import { renderCard, renderDiagram } from './render';

/**
 * The NED preview webview app (bundled to dist/webview/nedPreview.js).
 * Receives scenes from the host panel, renders them as SVG on a fixed light
 * "paper" (display-string colors are designed for a light canvas), and
 * provides zoom/fit/re-layout, hover tooltips, click-to-navigate and
 * SVG/PNG export.
 */

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  /** Layout seed per type fq-name (re-layout increments, like the IDE). */
  seeds: Record<string, number>;
  zoom: number;
}

interface SceneMessage {
  type: 'scene';
  scene: PreviewScene | null;
  icons: Record<string, IconAsset>;
  pinned: boolean;
}

const vscode = acquireVsCodeApi();
const state: PersistedState = vscode.getState() ?? { seeds: {}, zoom: 1 };
const icons = new IconStore();

let scene: PreviewScene | null = null;
let pinned = false;
let svg: SVGSVGElement | undefined;
let intrinsic = { w: 0, h: 0 };
let renderToken = 0;

// ---- static page structure ----

document.getElementById('root')!.innerHTML = `
  <div id="toolbar">
    <button id="zoomOut" title="Zoom out">−</button>
    <span id="zoomLabel">100%</span>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="zoomReset" title="Zoom to 100%">1:1</button>
    <button id="zoomFit" title="Fit to view">Fit</button>
    <span class="sep"></span>
    <button id="relayout" title="Re-layout unpinned submodules (new seed)">Re-layout</button>
    <span class="sep"></span>
    <button id="exportSvg" title="Export as SVG">SVG</button>
    <button id="exportPng" title="Export as PNG">PNG</button>
    <span id="pinState"></span>
  </div>
  <div id="paper"><div id="canvas"></div><div id="empty">Open a NED file to see its graphical preview.</div></div>
`;

const style = document.createElement('style');
style.textContent = `
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
  #paper { flex: 1 1 auto; overflow: auto; background: #ffffff; position: relative; }
  #canvas { padding: 8px; width: max-content; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           color: #888; font-size: 13px; text-align: center; padding: 0 24px; }
`;
document.head.appendChild(style);

const paper = document.getElementById('paper')!;
const canvas = document.getElementById('canvas')!;
const empty = document.getElementById('empty')!;
const zoomLabel = document.getElementById('zoomLabel')!;
const pinState = document.getElementById('pinState')!;

// ---- rendering ----

function seedFor(fq: string): number {
  return state.seeds[fq] ?? 1;
}

async function rerender(): Promise<void> {
  const token = ++renderToken;
  if (!scene) {
    canvas.replaceChildren();
    empty.style.display = 'flex';
    pinState.textContent = '';
    return;
  }
  const current = scene;
  const isDiagram = current.submodules !== undefined;
  const rendered = isDiagram
    ? renderDiagram(await buildDiagram(current, icons, seedFor(current.fqName)), current.simpleName)
    : renderCard(current, await buildCardFigure(current, icons));
  if (token !== renderToken) return; // a newer scene arrived while icons loaded

  svg = rendered;
  intrinsic = { w: Number(svg.getAttribute('width')), h: Number(svg.getAttribute('height')) };
  applyZoom();
  canvas.replaceChildren(svg);
  empty.style.display = 'none';
  pinState.textContent = pinned ? `📌 ${current.fqName}` : current.fqName;
}

function applyZoom(): void {
  if (svg) {
    svg.setAttribute('width', String(intrinsic.w * state.zoom));
    svg.setAttribute('height', String(intrinsic.h * state.zoom));
  }
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  vscode.setState(state);
}

function setZoom(z: number): void {
  state.zoom = Math.min(8, Math.max(0.1, z));
  applyZoom();
}

// ---- toolbar ----

document.getElementById('zoomIn')!.addEventListener('click', () => setZoom(state.zoom * 1.25));
document.getElementById('zoomOut')!.addEventListener('click', () => setZoom(state.zoom / 1.25));
document.getElementById('zoomReset')!.addEventListener('click', () => setZoom(1));
document.getElementById('zoomFit')!.addEventListener('click', () => {
  if (!intrinsic.w || !intrinsic.h) return;
  const pad = 24;
  setZoom(Math.min((paper.clientWidth - pad) / intrinsic.w, (paper.clientHeight - pad) / intrinsic.h));
});
document.getElementById('relayout')!.addEventListener('click', () => {
  if (!scene) return;
  state.seeds[scene.fqName] = seedFor(scene.fqName) + 1; // IDE: seed+1 per re-layout
  vscode.setState(state);
  void rerender();
});
paper.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---- export ----

function serializeSvg(): string {
  return svg ? new XMLSerializer().serializeToString(svg) : '';
}

document.getElementById('exportSvg')!.addEventListener('click', () => {
  if (!svg || !scene) return;
  vscode.postMessage({ type: 'export', format: 'svg', data: serializeSvg(), suggestedName: `${scene.simpleName}.svg` });
});

document.getElementById('exportPng')!.addEventListener('click', () => {
  if (!svg || !scene) return;
  const name = scene.simpleName;
  const scale = 2; // export at 2x for crispness
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = intrinsic.w * scale;
    c.height = intrinsic.h * scale;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    vscode.postMessage({ type: 'export', format: 'png', data, suggestedName: `${name}.png` });
  };
  // data: URI (allowed by img-src) — all embedded icons are data URIs already
  img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(serializeSvg())))}`;
});

// ---- interactions: click to navigate, double-click to open the type ----

function figureAt(target: EventTarget | null): { kind: 'sub' | 'conn'; index: number } | undefined {
  if (!(target instanceof Element)) return undefined;
  const subEl = target.closest('[data-sub]');
  if (subEl) return { kind: 'sub', index: Number(subEl.getAttribute('data-sub')) };
  const connEl = target.closest('[data-conn]');
  if (connEl) return { kind: 'conn', index: Number(connEl.getAttribute('data-conn')) };
  return undefined;
}

canvas.addEventListener('click', (e) => {
  const hit = figureAt(e.target);
  if (!hit || !scene) return;
  const target = hit.kind === 'sub' ? scene.submodules?.[hit.index] : scene.connections?.[hit.index];
  if (target) post('navigate', target.declUri, target.declRange);
});

canvas.addEventListener('dblclick', (e) => {
  const hit = figureAt(e.target);
  if (!hit || !scene || hit.kind !== 'sub') return;
  const sub = scene.submodules?.[hit.index];
  if (sub?.typeUri) post('openType', sub.typeUri, sub.typeRange);
});

function post(type: 'navigate' | 'openType', uri: string, range?: Range): void {
  vscode.postMessage({ type, uri, range });
}

// ---- host messages ----

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as SceneMessage;
  if (msg.type !== 'scene') return;
  scene = msg.scene;
  pinned = msg.pinned;
  icons.setAssets(msg.icons);
  void rerender();
});

vscode.postMessage({ type: 'ready' });
