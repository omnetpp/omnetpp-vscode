// Drives the bundled language server (dist/opp_lsp.js) the way a non-VS Code editor
// does: no transport flag (stdio is the default) and, unless a case says otherwise,
// no initializationOptions. Checks --help and where the NED path comes from:
// --ned-path, OMNETPP_NED_PATH, and initializationOptions.nedPath taking precedence.
import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'opp_lsp.js');

// Net uses Host, which lives in a library outside the workspace folder. Marker always
// has an error, so its workspace marker tells us the index is ready.
const tmp = mkdtempSync(join(tmpdir(), 'opp-lsp-cli-'));
const proj = join(tmp, 'proj');
const lib = join(tmp, 'lib');
mkdirSync(proj);
mkdirSync(lib);
const netText = 'network Net {\n  submodules:\n    h: Host;\n}\n';
writeFileSync(join(proj, 'Net.ned'), netText);
writeFileSync(join(proj, 'Marker.ned'), 'simple Marker {\n  parameters:\n    int n;\n    int n;\n}\n');
writeFileSync(join(lib, 'Host.ned'), 'simple Host {}\n');
const netUri = pathToFileURL(join(proj, 'Net.ned')).toString();
const markerUri = pathToFileURL(join(proj, 'Marker.ned')).toString();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Starts opp_lsp, opens Net.ned once the index is ready, and returns its diagnostics. */
async function netDiagnostics({ args = [], env = {}, initializationOptions } = {}) {
  const server = spawn(process.execPath, [cli, ...args], {
    cwd: tmp,
    env: { ...process.env, OMNETPP_NED_PATH: '', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const send = (msg) => {
    const json = JSON.stringify(msg);
    server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  };
  let buf = Buffer.alloc(0);
  const handlers = [];
  server.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const m = /Content-Length: (\d+)/i.exec(buf.slice(0, headerEnd).toString());
      if (!m) break;
      const start = headerEnd + 4;
      const len = parseInt(m[1], 10);
      if (buf.length < start + len) break;
      const body = buf.slice(start, start + len).toString();
      buf = buf.slice(start + len);
      handlers.slice().forEach((h) => h(JSON.parse(body)));
    }
  });
  const waitFor = (pred, timeoutMs = 10000) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), timeoutMs);
      const h = (msg) => {
        if (!pred(msg)) return;
        clearTimeout(t);
        handlers.splice(handlers.indexOf(h), 1);
        res(msg);
      };
      handlers.push(h);
    });

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(proj).toString(),
        capabilities: {},
        ...(initializationOptions ? { initializationOptions } : {}),
      },
    });
    await waitFor((m) => m.id === 1 && m.result);
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    await waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === markerUri && m.params.diagnostics.length > 0);
    const opened = waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === netUri);
    send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: netUri, languageId: 'OMNeT++ NED', version: 1, text: netText } },
    });
    return (await opened).params.diagnostics.map((d) => d.message);
  } finally {
    server.kill();
  }
}

const unresolved = (msgs) => msgs.some((m) => m.includes('Host'));

try {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert(help.status === 0, `--help exited with ${help.status}`);
  assert(help.stdout.startsWith('opp_lsp — '), '--help text missing');
  console.log('--help: OK');

  const plain = await netDiagnostics();
  assert(unresolved(plain), `expected an unresolved Host without a NED path, got: ${plain.join('; ')}`);
  console.log(`no NED path (default stdio): OK (${plain.join('; ')})`);

  const flag = await netDiagnostics({ args: ['--ned-path=lib'] });
  assert(!unresolved(flag), `--ned-path=lib (relative) did not resolve Host: ${flag.join('; ')}`);
  console.log('--ned-path (relative): OK');

  const fromEnv = await netDiagnostics({ args: ['--stdio'], env: { OMNETPP_NED_PATH: lib } });
  assert(!unresolved(fromEnv), `OMNETPP_NED_PATH did not resolve Host: ${fromEnv.join('; ')}`);
  console.log('OMNETPP_NED_PATH: OK');

  const fromInit = await netDiagnostics({ env: { OMNETPP_NED_PATH: join(tmp, 'missing') }, initializationOptions: { nedPath: lib } });
  assert(!unresolved(fromInit), `initializationOptions.nedPath did not take precedence: ${fromInit.join('; ')}`);
  console.log('initializationOptions.nedPath precedence: OK');

  console.log('LSP CLI SMOKE PASSED');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  console.error('LSP CLI SMOKE FAILED:', e.message);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
