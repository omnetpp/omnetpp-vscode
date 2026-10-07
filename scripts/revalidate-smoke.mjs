// Verifies the self-healing index revalidation: when a background process (here a
// real `git checkout`) adds/removes NED files WITHOUT the editor's file watcher
// delivering events, an `omnetpp/revalidate` notification must reconcile the index
// against disk so diagnostics reflect the new on-disk state.
//
// Project: Sub.ned declares `simple Sub extends Provider`; Provider is declared in
// Provider.ned. On branch `main` both files exist (Sub is valid). On branch `broken`
// Provider.ned is removed (Sub gets an "Unknown type 'Provider'" error). We flip
// branches with git, send only `omnetpp/revalidate`, and assert the diagnostics for
// the never-opened Sub.ned change accordingly — in BOTH directions (add + delete).
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const proj = mkdtempSync(join(tmpdir(), 'opp-reval-'));
const git = (...args) => execFileSync('git', args, { cwd: proj, stdio: 'pipe' });

// Two-file, two-branch git repo.
writeFileSync(join(proj, 'Provider.ned'), 'simple Provider { }\n');
writeFileSync(join(proj, 'Sub.ned'), 'simple Sub extends Provider { }\n');
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'smoke@example.com');
git('config', 'user.name', 'smoke');
git('add', '-A');
git('commit', '-qm', 'both files (Sub valid)');
git('checkout', '-qb', 'broken');
git('rm', '-q', 'Provider.ned');
git('commit', '-qm', 'remove Provider (Sub invalid)');
// start on the broken branch so the initial workspace pass publishes Sub's error
git('checkout', '-q', 'broken');

const subUri = pathToFileURL(join(proj, 'Sub.ned')).toString();

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

function waitFor(pred, timeoutMs = 10000) {
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

const isSubDiag = (m) =>
  m.method === 'textDocument/publishDiagnostics' && m.params.uri === subUri;

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
      capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      workspaceFolders: [{ uri: pathToFileURL(proj).toString(), name: 'proj' }],
      initializationOptions: { diagnostics: { scope: 'workspace' } },
    },
  });
  await waitFor((m) => m.id === 1 && m.result);
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  // initial state (broken branch): Sub.ned has the unresolved-supertype error
  const d0 = await waitFor((m) => isSubDiag(m) && m.params.diagnostics.length > 0);
  console.log(`initial (broken): Sub.ned has ${d0.params.diagnostics.length} diag — ${d0.params.diagnostics[0].message}`);

  // --- ADD path: restore Provider.ned via checkout, WITHOUT watch events ---
  git('checkout', '-q', 'main');
  send({ jsonrpc: '2.0', method: 'omnetpp/revalidate', params: {} });
  await waitFor((m) => isSubDiag(m) && m.params.diagnostics.length === 0);
  console.log('after checkout main + revalidate: Sub.ned cleared (added Provider.ned detected) — OK');

  // --- DELETE path: remove Provider.ned again via checkout, WITHOUT watch events ---
  git('checkout', '-q', 'broken');
  send({ jsonrpc: '2.0', method: 'omnetpp/revalidate', params: {} });
  const d2 = await waitFor((m) => isSubDiag(m) && m.params.diagnostics.length > 0);
  console.log(`after checkout broken + revalidate: Sub.ned error returned (deleted Provider.ned detected) — OK (${d2.params.diagnostics[0].message})`);

  console.log('revalidate smoke test PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('revalidate smoke test FAILED:', e.message);
  cleanup();
  process.exit(1);
}
