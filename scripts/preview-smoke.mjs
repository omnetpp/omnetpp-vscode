// Validates the omnetpp/nedPreview custom request over LSP stdio: opens a NED
// buffer, asks for the preview scene at a cursor position (and by pinned
// fq-name), and checks the scene shape (submodules, connections, display
// chains, icon prefetch list).
//
// Usage: bun scripts/preview-smoke.mjs [projectDir]   (after `bun run dev:build`)
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(process.argv[2] ?? join(root, 'samples'));

const server = spawn(process.execPath, [join(root, 'dist', 'server.js'), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = Buffer.alloc(0);
const handlers = [];
server.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, headerEnd).toString());
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
    handlers.forEach((h) => h(msg));
  }
});

let id = 1;
function send(msg) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...msg });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function request(method, params) {
  const reqId = id++;
  send({ id: reqId, method, params });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 15000);
    const h = (msg) => {
      if (msg.id === reqId) {
        clearTimeout(t);
        handlers.splice(handlers.indexOf(h), 1);
        msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result);
      }
    };
    handlers.push(h);
  });
}

const NED = `simple PNode { parameters: @display("i=device/pc"); gates: inout g[]; }
network PreviewSmokeNet
{
    parameters: @display("bgb=400,300");
    submodules:
        a: PNode { @display("p=80,80"); }
        b: PNode;
    connections:
        a.g++ <--> b.g++;
}
`;

try {
  await request('initialize', {
    processId: process.pid,
    rootUri: null,
    workspaceFolders: [{ uri: pathToFileURL(projectDir).toString(), name: 'proj' }],
    capabilities: {},
  });
  send({ method: 'initialized', params: {} });
  console.log('initialize: OK');

  const uri = pathToFileURL(join(projectDir, '__preview_smoke__.ned')).toString();
  send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'OMNeT++ NED', version: 1, text: NED } },
  });
  await new Promise((r) => setTimeout(r, 300));

  // cursor inside the network body -> the network's scene
  const scene = await request('omnetpp/nedPreview', { uri, position: { line: 4, character: 10 } });
  if (!scene || scene.simpleName !== 'PreviewSmokeNet') throw new Error(`wrong scene: ${JSON.stringify(scene)?.slice(0, 200)}`);
  if (scene.submodules?.length !== 2) throw new Error('expected 2 submodules');
  if (scene.connections?.length !== 1) throw new Error('expected 1 connection');
  if (!scene.icons.some((i) => i.id === 'device/pc')) throw new Error('expected device/pc in the icon list');
  if (!scene.displayChain.some((d) => d.includes('bgb=400,300'))) throw new Error('expected bgb in display chain');
  console.log(`nedPreview (cursor): OK (${scene.submodules.length} submodules, ${scene.connections.length} connection)`);

  // cursor on the simple module -> its icon card
  const card = await request('omnetpp/nedPreview', { uri, position: { line: 0, character: 10 } });
  if (!card || card.simpleName !== 'PNode' || card.submodules) throw new Error('expected the PNode card scene');
  console.log('nedPreview (card): OK');

  // pinned fq-name form
  const pinned = await request('omnetpp/nedPreview', { fqName: 'PreviewSmokeNet' });
  if (!pinned || pinned.simpleName !== 'PreviewSmokeNet') throw new Error('pinned scene lookup failed');
  console.log('nedPreview (pinned fqName): OK');

  console.log('NED preview smoke test PASSED');
  server.kill();
  process.exit(0);
} catch (e) {
  console.error('NED preview smoke test FAILED:', e.message);
  server.kill();
  process.exit(1);
}
