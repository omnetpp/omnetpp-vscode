// Validates the omnetpp/counterparts request (the .cc → .h → .ned switch)
// over LSP stdio against the bundled server, with C++ files that are NOT open
// as LSP documents (the server must answer from its on-disk C++ index).
//
// Usage (after `bun run dev:build`):
//   bun scripts/counterparts-smoke.mjs                       throwaway project, asserted
//   bun scripts/counterparts-smoke.mjs <projectDir> <file>…  real project, prints each ring
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const custom = process.argv.length > 2;
const projectDir = custom ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'opp-counterparts-'));
const files = custom ? process.argv.slice(3).map((f) => resolve(projectDir, f)) : [];

if (!custom) {
  const w = (rel, text) => {
    mkdirSync(dirname(join(projectDir, rel)), { recursive: true });
    writeFileSync(join(projectDir, rel), text);
  };
  w('src/app/Foo.ned', 'package app;\n@namespace(demo);\nsimple Foo {\n}\nsimple Other {\n  @class(OtherImpl);\n}\n');
  w('src/app/Foo.h', 'namespace demo {\nclass DEMO_API Foo : public cSimpleModule {\n};\n}\n');
  w('src/app/Foo.cc', '#include "Foo.h"\nnamespace demo {\nDefine_Module(Foo);\n}\n');
  w('src/impl/OtherImpl.cc', 'namespace demo {\nclass OtherImpl : public cSimpleModule {};\nDefine_Module(OtherImpl);\n}\n');
  files.push(...['src/app/Foo.cc', 'src/app/Foo.h', 'src/app/Foo.ned', 'src/impl/OtherImpl.cc'].map((f) => join(projectDir, f)));
}

const server = spawn(process.execPath, [join(root, 'dist', 'opp_lsp.js'), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

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
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
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
    const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 15000);
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

const counterparts = (file, position) =>
  request('omnetpp/counterparts', { uri: pathToFileURL(file).toString(), position });
const rel = (u) => relative(projectDir, fileURLToPath(u));
const show = (r) =>
  ['cc', 'h', 'ned'].map((k) => `${k}=[${r[k].map((t) => `${rel(t.uri)}${t.range ? '' : '*'}`).join(', ')}]`).join(' ');

function check(cond, what) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

let failed = false;
try {
  await request('initialize', {
    processId: process.pid,
    rootUri: null,
    workspaceFolders: [{ uri: pathToFileURL(projectDir).toString(), name: 'proj' }],
    capabilities: {},
  });
  send({ method: 'initialized', params: {} });

  // The disk index is built in the background and has no ready signal: poll
  // until the answers for all files stop changing.
  const deadline = Date.now() + 180_000;
  let last = '';
  for (let stable = 0; stable < 4; ) {
    const now = JSON.stringify(await Promise.all(files.map((f) => counterparts(f))));
    stable = now === last && now.includes('"range"') ? stable + 1 : 0;
    last = now;
    if (Date.now() > deadline) throw new Error('index did not settle in time');
    await new Promise((res) => setTimeout(res, 500));
  }

  const results = new Map();
  for (const f of files) {
    const r = await counterparts(f);
    results.set(relative(projectDir, f), r);
    console.log(`${relative(projectDir, f)} (${r.kind}): ${show(r)}`);
  }

  if (!custom) {
    const cc = results.get('src/app/Foo.cc');
    check(cc.h.length === 1 && rel(cc.h[0].uri) === 'src/app/Foo.h' && cc.h[0].range, '.cc → semantic .h (export macro)');
    check(cc.ned.length === 1 && cc.ned[0].label === 'app.Foo', '.cc → NED type app.Foo');
    const h = results.get('src/app/Foo.h');
    check(h.cc.length === 1 && rel(h.cc[0].uri) === 'src/app/Foo.cc', '.h → .cc');
    const ned = results.get('src/app/Foo.ned');
    check(ned.cc.length === 1 && rel(ned.cc[0].uri) === 'src/app/Foo.cc', '.ned without cursor → the same-named .cc');
    const atOther = await counterparts(join(projectDir, 'src/app/Foo.ned'), { line: 5, character: 4 });
    check(atOther.cc.length === 1 && rel(atOther.cc[0].uri) === 'src/impl/OtherImpl.cc', '.ned cursor in Other → @class(OtherImpl) .cc');
    const impl = results.get('src/impl/OtherImpl.cc');
    check(impl.ned.length === 1 && impl.ned[0].label === 'app.Other', '@class .cc → its NED type');
  } else {
    for (const [f, r] of results) check(r.cc.length + r.h.length + r.ned.length > 0, `${f} has counterparts`);
  }
} catch (e) {
  console.error(e.message);
  failed = true;
} finally {
  server.kill();
  if (!custom) rmSync(projectDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
