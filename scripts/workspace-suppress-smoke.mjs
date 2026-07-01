// Regression test for suppression in workspace-scope diagnostics: an inline
// `//# suppress(...)` directive must be honored for files that are NEVER opened in
// an editor, exactly as it is for open ones. Builds a throwaway project on disk,
// points the server at it as a workspace folder, and asserts that the suppressed
// file gets NO markers while an unsuppressed sibling (with the same error) does.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Two closed files, each with a duplicate-parameter error. Only Suppressed.ned
// carries the directive; Bad.ned does not.
const proj = mkdtempSync(join(tmpdir(), 'opp-wssuppress-'));
writeFileSync(
  join(proj, 'Suppressed.ned'),
  'simple Suppressed {\n  parameters:\n    int n;\n    //# suppress(duplicate)\n    int n;\n}\n',
);
writeFileSync(join(proj, 'Bad.ned'), 'simple Bad {\n  parameters:\n    int m;\n    int m;\n}\n');
const suppressedUri = pathToFileURL(join(proj, 'Suppressed.ned')).toString();
const badUri = pathToFileURL(join(proj, 'Bad.ned')).toString();

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
    handlers.forEach((h) => h(JSON.parse(body)));
  }
});

// Track the latest diagnostics published per uri.
const latest = new Map();
handlers.push((msg) => {
  if (msg.method === 'textDocument/publishDiagnostics') {
    latest.set(msg.params.uri, msg.params.diagnostics);
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // The unsuppressed sibling must report its error (proves the workspace pass ran).
  await waitFor(
    (m) =>
      m.method === 'textDocument/publishDiagnostics' &&
      m.params.uri === badUri &&
      m.params.diagnostics.length > 0,
  );
  console.log('unsuppressed Bad.ned publishDiagnostics: OK');

  // Let the whole debounced pass settle, then assert the suppressed file is clean.
  await delay(800);
  const suppressed = latest.get(suppressedUri) ?? [];
  if (suppressed.length > 0) {
    throw new Error(
      `suppressed file still has ${suppressed.length} marker(s): ` +
        suppressed.map((d) => `${d.code ?? '?'}:${d.message}`).join('; '),
    );
  }
  console.log('suppressed Suppressed.ned has no markers: OK');
  console.log('workspace-suppress smoke test PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('workspace-suppress smoke test FAILED:', e.message);
  cleanup();
  process.exit(1);
}
