// End-to-end LSP test of INI diagnostics (config + full param resolution).
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projDir = process.argv[2];
const iniPath = process.argv[3];

const server = spawn('node', [join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (m) => { const j = JSON.stringify(m); server.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`); };
let buf = Buffer.alloc(0); const handlers = [];
server.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const he = buf.indexOf('\r\n\r\n'); if (he < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, he).toString()); if (!m) break;
    const len = +m[1], start = he + 4; if (buf.length < start + len) break;
    handlers.forEach((h) => h(JSON.parse(buf.slice(start, start + len).toString()))); buf = buf.slice(start + len);
  }
});
const waitFor = (pred, ms = 10000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  const h = (m) => { if (pred(m)) { clearTimeout(t); handlers.splice(handlers.indexOf(h), 1); res(m); } };
  handlers.push(h);
});

try {
  const wsUri = pathToFileURL(projDir).toString();
  await waitForInit();
  async function waitForInit() {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: wsUri, workspaceFolders: [{ uri: wsUri, name: 'p' }], capabilities: {} } });
    await waitFor((m) => m.id === 1);
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }
  await new Promise((r) => setTimeout(r, 1500));
  const uri = pathToFileURL(iniPath).toString();
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'OMNeT++ INI', version: 1, text: readFileSync(iniPath, 'utf8') } } });
  const diag = await waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.length > 0);
  const codes = diag.params.diagnostics.map((d) => `${d.code}:${d.message}`);
  console.log('INI diagnostics:\n  ' + codes.join('\n  '));
  const need = ['param-value-type', 'no-matching-param', 'unknown-config'];
  for (const c of need) if (!codes.some((x) => x.startsWith(c))) throw new Error('missing ' + c);
  console.log('LSP INI smoke test PASSED');
  server.kill(); process.exit(0);
} catch (e) {
  console.error('LSP INI smoke test FAILED:', e.message);
  server.kill(); process.exit(1);
}
