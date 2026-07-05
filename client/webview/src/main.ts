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
  pinnedFqName?: string;
}

const vscode = acquireVsCodeApi();
const state: PersistedState = vscode.getState() ?? { seeds: {}, zoom: 1 };
const icons = new IconStore();

let scene: PreviewScene | null = null;
let pinnedFq: string | undefined;
let svg: SVGSVGElement | undefined;
let intrinsic = { w: 0, h: 0 };
let renderToken = 0;

// ---- static page structure ----

// self-contained inline SVG icons (codicon look-alikes; no external fonts)
const ICON = {
  zoomOut: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.75"/><path d="M10.5 10.5 14.5 14.5"/><path d="M4.5 6.5h4"/></g></svg>`,
  zoomIn: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.75"/><path d="M10.5 10.5 14.5 14.5"/><path d="M4.5 6.5h4M6.5 4.5v4"/></g></svg>`,
  zoomReset: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><text x="8" y="11.5" text-anchor="middle" font-size="8.5" font-weight="bold" font-family="sans-serif" fill="currentColor">1:1</text></svg>`,
  zoomFit: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H2v4"/><path d="M10 2h4v4"/><path d="M14 10v4h-4"/><path d="M6 14H2v-4"/></g></svg>`,
  pin: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.3 1.3 14.7 6.7l-1.4 1.4-.7-.35-2.5 2.5.35 2.85-1.4 1.4-3.2-3.2-3.15 3.2-1.2-1.2 3.2-3.15-3.2-3.2 1.4-1.4 2.85.35 2.5-2.5-.35-.7z"/></svg>`,
  clear: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5h8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-8L1.5 8z"/><path d="M8 6l4 4M12 6l-4 4"/></g></svg>`,
};

document.getElementById('root')!.innerHTML = `
  <div id="toolbar">
    <button id="zoomOut" title="Zoom out">${ICON.zoomOut}</button>
    <span id="zoomLabel">100%</span>
    <button id="zoomIn" title="Zoom in">${ICON.zoomIn}</button>
    <button id="zoomReset" title="Zoom to 100%">${ICON.zoomReset}</button>
    <button id="zoomFit" title="Fit to view">${ICON.zoomFit}</button>
    <input id="typeSearch" list="typeOptions" spellcheck="false" placeholder="type name">
    <datalist id="typeOptions"></datalist>
    <button id="pinBtn" title="Pin the preview to the current type">${ICON.pin}</button>
  </div>
  <div id="paper"><div id="canvas"></div><div id="empty">Open a NED file to see its graphical preview.</div></div>
`;

// Replace the meaningless default webview context menu (copy/cut/paste) with
// the extension's own items: package.json contributes Re-layout and the
// exports to "webview/context", matched via this webviewSection.
document.getElementById('root')!.dataset.vscodeContext = JSON.stringify({
  webviewSection: 'nedPreview',
  preventDefaultContextMenuItems: true,
});

// NOTE: no JS-injected <style> here. The page CSS lives in the host-generated
// HTML (nedPreviewPanel.buildHtml) where it carries the CSP nonce — a
// dynamically appended stylesheet has no nonce, and 'unsafe-inline' would be
// IGNORED by the browser because the CSP's style-src carries a nonce.

const paper = document.getElementById('paper')!;
const canvas = document.getElementById('canvas')!;
const empty = document.getElementById('empty')!;
const zoomLabel = document.getElementById('zoomLabel')!;
const typeSearch = document.getElementById('typeSearch') as HTMLInputElement;
const typeOptions = document.getElementById('typeOptions') as HTMLDataListElement;
const pinBtn = document.getElementById('pinBtn') as HTMLButtonElement;

// ---- rendering ----

function seedFor(fq: string): number {
  return state.seeds[fq] ?? 1;
}

async function rerender(): Promise<void> {
  const token = ++renderToken;
  if (!scene) {
    canvas.replaceChildren();
    empty.style.display = 'flex';
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
// ---- type search / pinning ----
// Unpinned: the box is empty and the currently shown type appears as the
// placeholder hint; the button is a PIN that copies that fq-name into the box
// (pinning the preview). Pinned: the box holds the pinned fq-name and the
// button turns into a CLEAR that empties the box and resumes cursor-following.

function syncSearchUi(): void {
  if (document.activeElement !== typeSearch) typeSearch.value = pinnedFq ?? '';
  typeSearch.placeholder = scene?.fqName ?? 'type name';
  pinBtn.innerHTML = pinnedFq ? ICON.clear : ICON.pin;
  pinBtn.title = pinnedFq
    ? 'Clear and follow the cursor again'
    : 'Pin the preview to the currently shown type';
}

function commitSearch(): void {
  const text = typeSearch.value.trim();
  if (text === (pinnedFq ?? '')) return;
  vscode.postMessage({ type: 'setPin', fqName: text || undefined });
}

pinBtn.addEventListener('click', () => {
  if (pinnedFq) {
    typeSearch.value = '';
    vscode.postMessage({ type: 'setPin' });
  } else if (scene) {
    typeSearch.value = scene.fqName;
    vscode.postMessage({ type: 'setPin', fqName: scene.fqName });
  }
});

typeSearch.addEventListener('change', commitSearch);
typeSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    commitSearch();
    typeSearch.blur();
  } else if (e.key === 'Escape') {
    typeSearch.value = pinnedFq ?? '';
    typeSearch.blur();
  }
});

// re-layout and the exports are reachable via the context menu (webview/context)
function doRelayout(): void {
  if (!scene) return;
  state.seeds[scene.fqName] = seedFor(scene.fqName) + 1; // IDE: seed+1 per re-layout
  vscode.setState(state);
  void rerender();
}
paper.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---- drag panning ----
// Left- or middle-button drag scrolls the paper. A small threshold keeps
// plain clicks working (click-to-navigate); once a real pan happened, the
// click that follows pointerup is swallowed.

const PAN_THRESHOLD = 4;
let panStart: { x: number; y: number; left: number; top: number; pointerId: number } | undefined;
let panned = false;

paper.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
  panStart = { x: e.clientX, y: e.clientY, left: paper.scrollLeft, top: paper.scrollTop, pointerId: e.pointerId };
  panned = false;
});

paper.addEventListener('pointermove', (e) => {
  if (!panStart || e.pointerId !== panStart.pointerId) return;
  const dx = e.clientX - panStart.x;
  const dy = e.clientY - panStart.y;
  if (!panned && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
  if (!panned) {
    panned = true;
    paper.classList.add('panning');
    paper.setPointerCapture(panStart.pointerId);
  }
  paper.scrollLeft = panStart.left - dx;
  paper.scrollTop = panStart.top - dy;
});

function endPan(e: PointerEvent): void {
  if (!panStart || e.pointerId !== panStart.pointerId) return;
  if (panned) paper.releasePointerCapture(panStart.pointerId);
  panStart = undefined;
  paper.classList.remove('panning');
  // `panned` stays true until the trailing click has been swallowed below
}
paper.addEventListener('pointerup', endPan);
paper.addEventListener('pointercancel', endPan);

// capture phase: runs before the navigation click handler on #canvas
paper.addEventListener('click', (e) => {
  if (panned) {
    e.stopPropagation();
    e.preventDefault();
    panned = false;
  }
}, { capture: true });

// ---- export ----

function serializeSvg(): string {
  return svg ? new XMLSerializer().serializeToString(svg) : '';
}

function doExportSvg(): void {
  if (!svg || !scene) return;
  vscode.postMessage({ type: 'export', format: 'svg', data: serializeSvg(), suggestedName: `${scene.simpleName}.svg` });
}

function doExportPng(): void {
  if (!svg || !scene) return;
  const name = scene.simpleName;
  const scale = 2; // export at 2x for crispness
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = intrinsic.w * scale;
    c.height = intrinsic.h * scale;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#a0e0a0'; // Qtenv's canvas green (like its print/export)
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    vscode.postMessage({ type: 'export', format: 'png', data, suggestedName: `${name}.png` });
  };
  // data: URI (allowed by img-src) — all embedded icons are data URIs already
  img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(serializeSvg())))}`;
}

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
  const msg = event.data as
    | SceneMessage
    | { type: 'command'; command: string }
    | { type: 'typeList'; types: string[] };
  if (msg.type === 'command') {
    // context-menu commands forwarded by the host panel
    if (msg.command === 'relayout') doRelayout();
    else if (msg.command === 'exportSvg') doExportSvg();
    else if (msg.command === 'exportPng') doExportPng();
    return;
  }
  if (msg.type === 'typeList') {
    typeOptions.replaceChildren(
      ...msg.types.map((t) => {
        const option = document.createElement('option');
        option.value = t;
        return option;
      }),
    );
    return;
  }
  if (msg.type !== 'scene') return;
  scene = msg.scene;
  pinnedFq = msg.pinnedFqName;
  icons.setAssets(msg.icons);
  syncSearchUi();
  void rerender();
});

vscode.postMessage({ type: 'ready' });
