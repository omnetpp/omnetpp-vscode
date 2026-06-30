// Drives the bundled language server over stdio with a minimal LSP handshake and
// a didOpen, asserting that diagnostics come back. Validates the real runtime path.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buf.slice(0, headerEnd).toString();
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString();
    buf = buf.slice(start + len);
    const msg = JSON.parse(body);
    handlers.forEach((h) => h(msg));
  }
});

function waitFor(pred, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for message')), timeoutMs);
    const h = (msg) => {
      if (pred(msg)) {
        clearTimeout(t);
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
        res(msg);
      }
    };
    handlers.push(h);
  });
}

const uri = 'file:///tmp/test.ned';
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } });
  await waitFor((m) => m.id === 1 && m.result);
  console.log('initialize: OK');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri,
        languageId: 'OMNeT++ NED',
        version: 1,
        text: 'simple Foo { parameters: int n = ; }',
      },
    },
  });
  const diag = await waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
  const count = diag.params.diagnostics.length;
  console.log(`publishDiagnostics: OK (${count} diagnostic(s))`);
  if (count < 1) throw new Error('expected at least 1 syntax diagnostic for malformed NED');
  console.log('LSP smoke test PASSED');
  server.kill();
  process.exit(0);
} catch (e) {
  console.error('LSP smoke test FAILED:', e.message);
  server.kill();
  process.exit(1);
}
