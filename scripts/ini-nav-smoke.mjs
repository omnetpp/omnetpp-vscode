// Drives the bundled language server over stdio and exercises the new INI
// param-line navigation: hover (matched modules), go-to-definition (ctrl-click),
// find references (NED decls + INI lines), codelens, and the [General] fallback
// via the omnetpp/activeConfigChanged notification.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const proj = mkdtempSync(join(tmpdir(), 'ini-nav-'));
writeFileSync(join(proj, '.nedfolders'), '.\n');
const NED = `
simple App { parameters: int p = default(0); }
module Host { submodules: app: App; }
network Net { submodules: host: Host; }
`;
const INI = `[General]
**.host.app.p = 5

[Config C]
network = Net
**.host.app.p = 1
**.host.app.nope = 9
`;
writeFileSync(join(proj, 'net.ned'), NED);
writeFileSync(join(proj, 'omnetpp.ini'), INI);
const nedUri = pathToFileURL(join(proj, 'net.ned')).href;
const iniUri = pathToFileURL(join(proj, 'omnetpp.ini')).href;
const rootUri = pathToFileURL(proj).href;

const server = spawn(process.execPath, [join(root, 'dist', 'server.js'), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
function send(msg) {
  const json = JSON.stringify(msg);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
let buf = Buffer.alloc(0);
const handlers = [];
server.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const he = buf.indexOf('\r\n\r\n');
    if (he < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, he).toString());
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = he + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
    handlers.forEach((h) => h(msg));
  }
});
function waitFor(pred, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), timeoutMs);
    const h = (msg) => {
      if (pred(msg)) {
        clearTimeout(t);
        handlers.splice(handlers.indexOf(h), 1);
        res(msg);
      }
    };
    handlers.push(h);
  });
}
let nextId = 100;
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return waitFor((m) => m.id === id).then((m) => m.result);
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

try {
  await request('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'proj' }],
    capabilities: {},
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  // give the disk index a moment to build
  await new Promise((r) => setTimeout(r, 800));

  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: iniUri, languageId: 'OMNeT++ INI', version: 1, text: INI } },
  });
  await new Promise((r) => setTimeout(r, 300));

  // Cursor on the `[Config C]` param key: `**.host.app.p` is on line 5, col 2.
  const cPos = { line: 5, character: 2 };

  const hover = await request('textDocument/hover', { textDocument: { uri: iniUri }, position: cPos });
  assert(hover && /matching module parameter/.test(hover.contents.value), 'hover should list matched modules');
  assert(/Net\.host\.app/.test(hover.contents.value), 'hover should mention Net.host.app');
  console.log('hover: OK');

  const def = await request('textDocument/definition', { textDocument: { uri: iniUri }, position: cPos });
  const defArr = Array.isArray(def) ? def : def ? [def] : [];
  assert(defArr.length === 1 && defArr[0].uri === nedUri, 'definition should jump to net.ned');
  console.log('definition (ctrl-click): OK');

  const refs = await request('textDocument/references', {
    textDocument: { uri: iniUri },
    position: cPos,
    context: { includeDeclaration: true },
  });
  assert(Array.isArray(refs) && refs.some((r) => r.uri === nedUri), 'references should include the NED decl');
  assert(refs.some((r) => r.uri === iniUri), 'references should include INI assignment line(s)');
  console.log(`references: OK (${refs.length} locations)`);

  const lenses = await request('textDocument/codeLens', { textDocument: { uri: iniUri } });
  const cLens = (lenses || []).find((l) => l.range.start.line === 5);
  assert(cLens && /module parameter/.test(cLens.command.title), 'codelens should show module-parameter count');
  console.log(`codelens: OK ("${cLens.command.title}")`);

  // Unknown parameter `**.host.app.nope` (line 6): definition falls back to the module.
  const nopePos = { line: 6, character: 2 };
  const nopeDef = await request('textDocument/definition', { textDocument: { uri: iniUri }, position: nopePos });
  const nopeArr = Array.isArray(nopeDef) ? nopeDef : nopeDef ? [nopeDef] : [];
  assert(nopeArr.length === 1 && nopeArr[0].uri === nedUri, 'unknown-param definition should fall back to the module in net.ned');
  console.log('definition fallback to module (unknown param): OK');

  // [General] line has no network on its own → no matches until active config set.
  const gPos = { line: 1, character: 2 };
  const gHoverBefore = await request('textDocument/hover', { textDocument: { uri: iniUri }, position: gPos });
  assert(!gHoverBefore, '[General] hover should be empty with no active config');

  send({ jsonrpc: '2.0', method: 'omnetpp/activeConfigChanged', params: { uri: iniUri, name: 'C' } });
  await new Promise((r) => setTimeout(r, 300));
  const gHoverAfter = await request('textDocument/hover', { textDocument: { uri: iniUri }, position: gPos });
  assert(gHoverAfter && /Net\.host\.app/.test(gHoverAfter.contents.value), '[General] hover should resolve via active config');
  console.log('[General] active-config fallback: OK');

  console.log('\nINI navigation smoke test PASSED');
  server.kill();
  process.exit(0);
} catch (e) {
  console.error('INI navigation smoke test FAILED:', e.message);
  server.kill();
  process.exit(1);
}
