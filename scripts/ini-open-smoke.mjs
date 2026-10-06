// Verifies that an OPEN INI buffer, not its disk version, drives the INI index:
// the "unused network" hints on an open NED file must follow the buffer when the
// INI is open at startup, after an edit, and fall back to the disk text on close.
// Builds a throwaway project, drives dist/server.js over LSP stdio.
// Usage: bun scripts/ini-open-smoke.mjs   (after `bun run dev:build`)
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const proj = mkdtempSync(join(tmpdir(), 'opp-iniopen-'));
const NED_TEXT = 'network Net {\n}\nnetwork Other {\n}\n';
writeFileSync(join(proj, 'Nets.ned'), NED_TEXT);
writeFileSync(join(proj, 'omnetpp.ini'), '[General]\nnetwork = Net\n');
const nedUri = pathToFileURL(join(proj, 'Nets.ned')).toString();
const iniUri = pathToFileURL(join(proj, 'omnetpp.ini')).toString();

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
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, headerEnd).toString());
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString();
    buf = buf.slice(start + len);
    handlers.slice().forEach((h) => h(JSON.parse(body)));
  }
});

function waitFor(pred, what, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${typeof what === 'function' ? what() : what}`)), timeoutMs);
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

/** Wait until the NED file's published unused-network hints name exactly `expected`. */
let lastFlagged = '(none published)';
async function expectUnused(expected, step) {
  const want = [...expected].sort().join(',');
  await waitFor((m) => {
    if (m.method !== 'textDocument/publishDiagnostics' || m.params.uri !== nedUri) return false;
    lastFlagged = m.params.diagnostics
      .filter((d) => d.code === 'unused-network')
      .map((d) => /Network '(\w+)'/.exec(d.message)?.[1])
      .sort()
      .join(',');
    return lastFlagged === want;
  }, () => `${step}: unused networks [${want}] (last published: [${lastFlagged}])`);
  console.log(`${step}: OK (unused: [${want}])`);
}

function cleanup() {
  server.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* ignore */ }
}

const openIni = (text) => send({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: iniUri, languageId: 'OMNeT++ INI', version: 1, text } },
});

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
    },
  });
  await waitFor((m) => m.id === 1 && m.result, 'initialize');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  // A restored window: both files open while the startup scan runs, the INI
  // buffer already differing from disk (which runs Net).
  openIni('[General]\nnetwork = Other\n');
  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: nedUri, languageId: 'OMNeT++ NED', version: 1, text: NED_TEXT } },
  });
  await expectUnused(['Net'], 'INI open at startup');

  send({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { textDocument: { uri: iniUri, version: 2 }, contentChanges: [{ text: '[General]\n' }] },
  });
  await expectUnused(['Net', 'Other'], 'INI buffer edited');

  send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: iniUri } } });
  await expectUnused(['Other'], 'INI closed (disk text)');

  console.log('open-INI index smoke test PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('open-INI index smoke test FAILED:', e.message);
  cleanup();
  process.exit(1);
}
