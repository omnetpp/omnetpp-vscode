// End-to-end LSP test with a real workspace: opens files, checks cross-file
// semantic diagnostics (unknown types) and document symbols.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projDir = process.argv[2];
if (!projDir) { console.error('usage: lsp-project-smoke.mjs <projectDir>'); process.exit(2); }

const server = spawn(process.execPath, [join(root, 'dist', 'opp_lsp.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (m) => { const j = JSON.stringify(m); server.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`); };
let buf = Buffer.alloc(0); const handlers = [];
server.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const he = buf.indexOf('\r\n\r\n'); if (he < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, he).toString()); if (!m) break;
    const len = +m[1], start = he + 4; if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString()); buf = buf.slice(start + len);
    handlers.forEach((h) => h(msg));
  }
});
const waitFor = (pred, ms = 10000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  const h = (m) => { if (pred(m)) { clearTimeout(t); handlers.splice(handlers.indexOf(h), 1); res(m); } };
  handlers.push(h);
});
const req = (() => { let id = 0; return (method, params) => { const myId = ++id; send({ jsonrpc: '2.0', id: myId, method, params }); return waitFor((m) => m.id === myId); }; })();
const openDoc = (path, langId) => {
  const uri = pathToFileURL(path).toString();
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: langId, version: 1, text: readFileSync(path, 'utf8') } } });
  return uri;
};

try {
  const wsUri = pathToFileURL(projDir).toString();
  await req('initialize', { processId: process.pid, rootUri: wsUri, workspaceFolders: [{ uri: wsUri, name: 'proj' }], capabilities: {} });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  // give the index time to build
  await new Promise((r) => setTimeout(r, 1500));

  const badUri = openDoc(join(projDir, 'app', 'Bad.ned'), 'OMNeT++ NED');
  const badDiag = await waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === badUri && m.params.diagnostics.length > 0);
  const badCodes = badDiag.params.diagnostics.map((d) => `${d.code}:${d.message}`);
  console.log('Bad.ned diagnostics:', badCodes);
  if (!badCodes.some((c) => /NoSuchType/.test(c))) throw new Error('expected unknown-type for NoSuchType');
  if (!badCodes.some((c) => /AlsoMissing/.test(c))) throw new Error('expected unknown-type for AlsoMissing');

  const aUri = openDoc(join(projDir, 'app', 'A.ned'), 'OMNeT++ NED');
  const aDiag = await waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === aUri);
  console.log('A.ned diagnostics:', aDiag.params.diagnostics.map((d) => d.message));
  if (aDiag.params.diagnostics.length !== 0) throw new Error('expected no diagnostics for valid A.ned');

  const syms = await req('textDocument/documentSymbol', { textDocument: { uri: aUri } });
  console.log('A.ned symbols:', syms.result.map((s) => s.name));
  if (!syms.result.some((s) => s.name === 'A')) throw new Error('expected symbol A');

  console.log('LSP PROJECT smoke test PASSED');
  server.kill(); process.exit(0);
} catch (e) {
  console.error('LSP PROJECT smoke test FAILED:', e.message);
  server.kill(); process.exit(1);
}
