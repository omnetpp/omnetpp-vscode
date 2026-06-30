import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proj = process.argv[2];
const ned = process.argv[3];
const server = spawn(process.execPath, [join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (m) => { const j = JSON.stringify(m); server.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`); };
let buf = Buffer.alloc(0);
const handlers = [];
server.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const he = buf.indexOf('\r\n\r\n');
    if (he < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, he).toString());
    if (!m) break;
    const len = +m[1];
    const start = he + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
    handlers.forEach((h) => h(msg));
  }
});
const waitFor = (p, ms = 10000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  const h = (m) => { if (p(m)) { clearTimeout(t); handlers.splice(handlers.indexOf(h), 1); res(m); } };
  handlers.push(h);
});
let id = 0;
const req = (method, params) => { const myId = ++id; send({ jsonrpc: '2.0', id: myId, method, params }); return waitFor((m) => m.id === myId); };

try {
  const wsUri = pathToFileURL(proj).toString();
  await req('initialize', { processId: process.pid, rootUri: wsUri, workspaceFolders: [{ uri: wsUri, name: 'p' }], capabilities: {} });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  await new Promise((r) => setTimeout(r, 1200));
  const uri = pathToFileURL(ned).toString();
  const text = readFileSync(ned, 'utf8');
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'OMNeT++ NED', version: 1, text } } });
  await new Promise((r) => setTimeout(r, 400));
  const netLine = text.split('\n').findIndex((l) => l.includes('network Net'));
  const r = await req('omnetpp/moduleHierarchy', { uri, position: { line: netLine, character: 8 } });
  console.log(JSON.stringify(r.result, null, 1));
  server.kill();
  process.exit(0);
} catch (e) {
  console.error('FAILED', e.message);
  server.kill();
  process.exit(1);
}
