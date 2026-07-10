// Headless smoke test for the Sequence Chart WEBVIEW bundle: loads the real
// dist/webview/sequenceChart.js under happy-dom (recording canvas contexts, stub
// ResizeObserver/vscode API), wires its host messages to a REAL EventLogSession +
// dist/eventlogWorker.js, and asserts the chart actually paints (canvas draw ops,
// hidden empty-state, populated status strip, no runtime errors).
//
// This covers the browser-only glue (DOM scaffold, init handshake, render loop)
// that bun's DOM-free unit tests and the session-level eventlog-ui-smoke cannot
// reach -- the layer where "everything green but nothing renders" bugs live.
// (It still cannot catch extension-host-only issues, e.g. the Electron
// ELECTRON_RUN_AS_NODE spawn fix in workerClient.ts -- F5 verification remains
// the final word for those.)
//
// Usage: bun scripts/eventlog-webview-smoke.mjs [<elog-file>]   (after `bun run dev:build`)
import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const elogPath = resolve(process.argv[2] ?? join(repo, 'shared/src/test/fixtures/elog/sample/Fifo1-#0.elog'));
const bundlePath = join(repo, 'dist/webview/sequenceChart.js');
const workerPath = join(repo, 'dist/eventlogWorker.js');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

if (!fs.existsSync(bundlePath) || !fs.existsSync(workerPath)) {
  console.error(`bundles missing -- run 'bun run dev:build' first`);
  process.exit(1);
}

// ---------- DOM environment ----------
const win = new Window({ url: 'https://webview.local/' });
globalThis.window = win;
globalThis.document = win.document;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.MessageEvent = win.MessageEvent;
globalThis.MutationObserver = win.MutationObserver;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.Node = win.Node;
globalThis.HTMLElement = win.HTMLElement;
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { queueMicrotask(() => this.cb([{ target: el, contentRect: { width: 1200, height: 800 } }])); }
  unobserve() {}
  disconnect() {}
};

// Recording 2D contexts: every method call is counted by name; property sets are
// accepted; measureText approximates. STRICT like a real Chromium canvas where it
// matters: arc/ellipse/roundRect throw IndexSizeError on negative radii (a real
// render loop dies mid-frame on those -- the exact class of bug a permissive stub
// waves through), and non-finite coordinates are counted (silently-invisible drawing).
const allCtxCounts = [];
let nonFiniteArgs = 0;
function makeCtx() {
  const counts = {};
  allCtxCounts.push(counts);
  const state = {};
  return new Proxy(state, {
    get(t, p) {
      if (p === 'measureText') return (s) => ({ width: String(s).length * 7 });
      if (p === 'canvas') return { width: 1200, height: 800 };
      if (p in t) return t[p];
      if (typeof p === 'string') {
        return (...args) => {
          counts[p] = (counts[p] || 0) + 1;
          if (p === 'arc' && args[2] < 0) throw new Error(`IndexSizeError: arc() radius ${args[2]} is negative`);
          if (p === 'ellipse' && (args[2] < 0 || args[3] < 0)) throw new Error(`IndexSizeError: ellipse() radius (${args[2]}, ${args[3]}) is negative`);
          if (p === 'roundRect' && args[4] < 0) throw new Error(`IndexSizeError: roundRect() radius ${args[4]} is negative`);
          if (['moveTo', 'lineTo', 'arc', 'ellipse', 'fillRect', 'strokeRect', 'fillText'].includes(p)) {
            for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) nonFiniteArgs++;
          }
        };
      }
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
win.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(); };

const toHost = [];
let hostHandler = null;
globalThis.acquireVsCodeApi = () => ({
  postMessage: (m) => { toHost.push(m); hostHandler?.(m); },
  getState: () => undefined,
  setState: () => {},
});

// Emulate the webview CSP's style-src-attr (no allowance): inline style="..."
// attributes are BLOCKED in real VS Code webviews -- happy-dom enforces no CSP, so
// intercept the two vectors that create them and fail the run instead (this exact
// gap hid a zero-height chart container: see the 'no CSP-blocked style attributes'
// assertion below).
const styleAttrViolations = [];
// (Only the innerHTML vector is checked: happy-dom routes ALLOWED CSSOM writes
// (el.style.x = ...) through setAttribute('style') internally, so hooking
// setAttribute would flag legal styling. Direct setAttribute('style') calls in
// source are caught by client/webview/src/test/noInlineStyleAttrs.test.ts instead.)
{
  const innerHTMLDescriptor = Object.getOwnPropertyDescriptor(win.Element.prototype, 'innerHTML');
  Object.defineProperty(win.Element.prototype, 'innerHTML', {
    ...innerHTMLDescriptor,
    set(value) {
      if (/<[^>]*\sstyle\s*=/.test(String(value))) styleAttrViolations.push(`innerHTML with style attribute: ${String(value).slice(0, 120)}`);
      innerHTMLDescriptor.set.call(this, value);
    },
  });
}

const errors = [];
process.on('unhandledRejection', (e) => errors.push(`unhandledRejection: ${e?.stack ?? e}`));
process.on('uncaughtException', (e) => errors.push(`uncaughtException: ${e?.stack ?? e}`));

document.body.innerHTML = '<div id="root"></div>';

// ---------- real session + worker, driven like sequenceChartEditor.ts ----------
const { EventLogSession } = await import(pathToFileURL(join(repo, 'client/src/eventlog/eventLogSession.ts')));
const session = new EventLogSession('elog:webview-smoke', elogPath, workerPath, {});
const summary = await session.initialize();

function deliver(data) {
  win.dispatchEvent(new win.MessageEvent('message', { data }));
}

hostHandler = async (m) => {
  switch (m.type) {
    case 'ready':
      deliver({
        type: 'init', fileUri: pathToFileURL(elogPath).toString(),
        // "Bookmark Info" starts on, so the notes-layer smoke check below doesn't need to
        // drive the Show/Hide context menu (a second floating DOM overlay) headlessly.
        persistedState: { version: 2, displayFlags: { showBookmarkInfo: true } },
        settings: { sequenceChart: {}, eventlog: {} },
        summary, selection: { eventNumbers: [] }, bookmarks: [], filterParams: null,
      });
      break;
    case 'engineRequest':
      try {
        const result = await session.handleEngineRequest(m.method, m.params);
        deliver({ type: 'engineResponse', id: m.id, result });
      } catch (err) {
        deliver({ type: 'engineResponse', id: m.id, error: { message: String(err?.message ?? err) } });
      }
      break;
    default:
      break; // stateChanged/selectionChanged/contextValue etc. are fine to ignore here
  }
};

await import(pathToFileURL(bundlePath));

// Let the ready->init->fetch->render cascade settle (several async round trips).
await new Promise((r) => setTimeout(r, 2500));

// ---------- assertions ----------
const requestMethods = toHost.filter((m) => m.type === 'engineRequest').map((m) => m.method);
assert(toHost.some((m) => m.type === 'ready'), 'webview posted ready');
assert(requestMethods.includes('elog/sc/getViewport'), 'webview fetched a viewport');
assert(requestMethods.includes('elog/getModuleTree'), 'webview fetched the module tree');

const totals = {};
for (const c of allCtxCounts) for (const [k, v] of Object.entries(c)) totals[k] = (totals[k] || 0) + v;
assert((totals.fillText ?? 0) > 10, `canvas drew text labels (fillText=${totals.fillText ?? 0})`);
assert((totals.lineTo ?? 0) > 20, `canvas drew lines (lineTo=${totals.lineTo ?? 0})`);
assert((totals.arc ?? 0) + (totals.ellipse ?? 0) > 0, `canvas drew event marks/arcs (arc=${totals.arc ?? 0}, ellipse=${totals.ellipse ?? 0})`);

const emptyEl = document.getElementById('empty');
assert(emptyEl && emptyEl.style.display === 'none', 'empty-state placeholder is hidden');
// The chart no longer has a top status strip (removed); the toolbar stands in for it.
assert(document.getElementById('status') === null, 'chart has no top status strip');
assert(errors.length === 0, `no runtime errors${errors.length ? `:\n${errors.join('\n')}` : ''}`);
assert(nonFiniteArgs === 0, `no non-finite canvas coordinates (got ${nonFiniteArgs})`);
assert(styleAttrViolations.length === 0, `no CSP-blocked style attributes${styleAttrViolations.length ? `:\n${styleAttrViolations.join('\n')}` : ''}`);

// Toolbar Home/End must SELECT the first/last navigable event, not just scroll to it
// (they used to diverge from the context menu's "Go to Begin"/"Go to End", which always
// selected -- see chartMain.ts's goToBegin()/goToEnd() doc comments).
toHost.length = 0;
document.getElementById('home').click();
await new Promise((r) => setTimeout(r, 200));
const expectedBegin = summary.firstEventNumber === 0 && summary.lastEventNumber > 0 ? 1 : summary.firstEventNumber;
const homeSelection = toHost.filter((m) => m.type === 'selectionChanged').pop();
assert(homeSelection && homeSelection.selection.eventNumbers.length === 1 && homeSelection.selection.eventNumbers[0] === expectedBegin, `Home button selects the first navigable event (#${expectedBegin}), got ${JSON.stringify(homeSelection?.selection.eventNumbers)}`);

// "Bookmark Info" note boxes: deliver a bookmarksChanged for the event Home just centered
// on (so its flag glyph -- and therefore the note's anchor -- is on screen), plus an
// Axis-kind bookmark on the root module (exercising the separate pinned-left-gutter
// packing pool -- see chartMain.ts's repositionBookmarkNotes()). Note positioning reads
// the PREVIOUS frame's drawn bookmarkMark primitives (a deliberate one-frame lag), so this
// needs two render ticks after the bookmarks appear: one to actually draw the flags, one
// to read them back.
deliver({
  type: 'bookmarksChanged',
  bookmarks: [
    { id: 'bm1', kind: 'Event', label: 'Test Bookmark', eventNumber: expectedBegin, note: '**bold** note' },
    { id: 'bm2', kind: 'Axis', label: 'Axis Bookmark', modulePath: 'SingleQueue' },
  ],
});
await new Promise((r) => setTimeout(r, 200));
document.getElementById('zoomIn').click();
document.getElementById('zoomOut').click();
await new Promise((r) => setTimeout(r, 200));
const noteTitles = [...document.querySelectorAll('.elog-bookmark-note-title')].map((el) => el.textContent);
assert(noteTitles.includes('Axis Bookmark'), `Axis-kind bookmark also gets a note box (separate pinned packing pool), got titles: ${JSON.stringify(noteTitles)}`);
assert(noteTitles.includes('Test Bookmark'), `bookmark note box renders its title, got titles: ${JSON.stringify(noteTitles)}`);
const noteBodyEl = document.querySelector('.elog-bookmark-note-body');
assert(noteBodyEl && noteBodyEl.innerHTML.includes('<strong>bold</strong>'), `bookmark note body renders markdown, got ${noteBodyEl?.innerHTML}`);

toHost.length = 0;
document.getElementById('gotoEnd').click();
await new Promise((r) => setTimeout(r, 200));
const endSelection = toHost.filter((m) => m.type === 'selectionChanged').pop();
assert(endSelection && endSelection.selection.eventNumbers.length === 1 && endSelection.selection.eventNumbers[0] === summary.lastEventNumber, `End button selects the last event (#${summary.lastEventNumber}), got ${JSON.stringify(endSelection?.selection.eventNumbers)}`);

await session.detach('chart', {});
console.log(failures === 0 ? '\neventlog-webview-smoke PASSED' : `\neventlog-webview-smoke FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
