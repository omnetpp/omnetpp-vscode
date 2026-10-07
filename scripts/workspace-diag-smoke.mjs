// Verifies workspace-scope diagnostics: a NED file that is NEVER opened, but lives
// under the workspace folder, must still get problem markers published. Builds a
// throwaway project on disk, points the server at it as a workspace folder, and
// asserts publishDiagnostics arrives for the *closed* file.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A two-file project: Net references Host, which declares a duplicate parameter
// (a local semantic error) — neither file is ever opened in an "editor".
const proj = mkdtempSync(join(tmpdir(), 'opp-wsdiag-'));
writeFileSync(join(proj, 'Host.ned'), 'simple Host {\n  parameters:\n    int n;\n    int n;\n}\n');
writeFileSync(join(proj, 'Net.ned'), 'network Net {\n  submodules:\n    h: Host;\n}\n');
const closedUri = pathToFileURL(join(proj, 'Host.ned')).toString();

const server = spawn(process.execPath, [join(root, 'dist', 'opp_lsp.js'), '--stdio'], {
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
    handlers.forEach((h) => h(JSON.parse(body)));
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

function cleanup() {
  server.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(proj).toString(), name: 'proj' }],
      initializationOptions: { diagnostics: { scope: 'workspace' } },
    },
  });
  await waitFor((m) => m.id === 1 && m.result);
  console.log('initialize: OK');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  const diag = await waitFor(
    (m) =>
      m.method === 'textDocument/publishDiagnostics' &&
      m.params.uri === closedUri &&
      m.params.diagnostics.length > 0,
  );
  console.log(`closed-file publishDiagnostics: OK (${diag.params.diagnostics.length} diagnostic(s))`);
  console.log(`  → ${diag.params.diagnostics.map((d) => d.message).join('; ')}`);
  console.log('workspace-diagnostics smoke test PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('workspace-diagnostics smoke test FAILED:', e.message);
  cleanup();
  process.exit(1);
}
