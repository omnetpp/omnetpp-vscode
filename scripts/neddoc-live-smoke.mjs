// Validates the omnetpp/generateDocs custom request over LSP stdio: indexes a
// throwaway project, generates HTML documentation into a temp dir via the
// LIVE server index (including an unsaved buffer), and checks the output tree
// and the progress notifications.
//
// Usage: bun scripts/neddoc-live-smoke.mjs   (after `bun run dev:build`)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = mkdtempSync(join(tmpdir(), 'opp-neddoc-live-'));
writeFileSync(
  join(projectDir, 'lib.ned'),
  '// On-disk node.\nsimple DiskNode { gates: inout g[]; }\n',
);

const server = spawn(process.execPath, [join(root, 'dist', 'opp_lsp.js'), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = Buffer.alloc(0);
const handlers = [];
const notifications = [];
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
    if (msg.method && msg.id === undefined) notifications.push(msg);
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
    const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 30000);
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
function cleanup() {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  server.kill();
}

try {
  await request('initialize', {
    processId: process.pid,
    rootUri: null,
    workspaceFolders: [{ uri: pathToFileURL(projectDir).toString(), name: 'proj' }],
    capabilities: {},
  });
  send({ method: 'initialized', params: {} });
  console.log('initialize: OK');

  // an UNSAVED buffer adds a network — must appear in the docs
  const uri = pathToFileURL(join(projectDir, 'net.ned')).toString();
  send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri,
        languageId: 'OMNeT++ NED',
        version: 1,
        text: '// Unsaved network using ~DiskNode.\nnetwork LiveNet { submodules: n: DiskNode; }\n',
      },
    },
  });
  await new Promise((r) => setTimeout(r, 500));

  const outputDir = join(projectDir, 'docs-out');
  const result = await request('omnetpp/generateDocs', { outputDir, format: 'html' });
  if (!result || result.pages < 3) throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  if (!existsSync(join(outputDir, 'index.html'))) throw new Error('index.html missing');
  if (!existsSync(join(outputDir, 'types', 'DiskNode.html'))) throw new Error('on-disk type page missing');
  if (!existsSync(join(outputDir, 'types', 'LiveNet.html'))) throw new Error('unsaved-buffer type page missing');
  const liveNet = readFileSync(join(outputDir, 'types', 'LiveNet.html'), 'utf8');
  if (!liveNet.includes('href="DiskNode.html"')) throw new Error('~DiskNode ref not linked');
  if (!result.indexPath.endsWith('index.html')) throw new Error('bad indexPath');
  console.log(`generateDocs: OK (${result.pages} pages, ${result.diagrams} diagrams, ${result.files} files)`);

  const progressed = notifications.filter((n) => n.method === 'omnetpp/generateDocsProgress');
  if (progressed.length === 0) throw new Error('no progress notifications received');
  const percents = progressed.map((n) => n.params.percent);
  if (percents.some((p) => typeof p !== 'number' || p < 0 || p > 100)) throw new Error(`bad percent values: ${percents}`);
  for (let i = 1; i < percents.length; i++)
    if (percents[i] < percents[i - 1]) throw new Error(`percent regression: ${percents.join(',')}`);
  if (percents[percents.length - 1] !== 100) throw new Error(`final percent should be 100, got ${percents[percents.length - 1]}`);
  console.log(`progress notifications: OK (${progressed.length}, ${Math.round(percents[0])}%..100%)`);

  // options from the settings-backed params: title, custom css, full diagram
  const cssFile = join(projectDir, 'my.css');
  writeFileSync(cssFile, 'body { background: hotpink; }');
  const out2 = join(projectDir, 'docs-out2');
  const r2 = await request('omnetpp/generateDocs', {
    outputDir: out2,
    format: 'html',
    title: 'Configured Title',
    customCssPath: cssFile,
    fullInheritanceDiagram: true,
    sourceListings: false,
  });
  if (r2.pages < 3) throw new Error('second run failed');
  if (!readFileSync(join(out2, 'index.html'), 'utf8').includes('Configured Title')) throw new Error('title not applied');
  if (!readFileSync(join(out2, 'assets', 'style.css'), 'utf8').includes('hotpink')) throw new Error('custom css not applied');
  if (!existsSync(join(out2, 'full-ned-inheritance-diagram.html'))) throw new Error('full inheritance page missing');
  if (readFileSync(join(out2, 'types', 'DiskNode.html'), 'utf8').includes('Source code'))
    throw new Error('source listings should be disabled');
  console.log('settings-backed options: OK');

  console.log('NEDDOC LIVE SMOKE PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('NEDDOC LIVE SMOKE FAILED:', e.message);
  cleanup();
  process.exit(1);
}
