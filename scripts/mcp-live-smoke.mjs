// Validates the LSP server's live-index MCP bridge (omnetpp/mcp/* custom
// requests) over stdio: lists tools, queries the indexed project, and proves an
// UNSAVED buffer (didOpen, not on disk) is reflected in tool results.
//
// Usage: bun scripts/mcp-live-smoke.mjs <projectDir>   (after `bun run dev:build`)
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(process.argv[2] ?? join(root, 'samples'));

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

try {
  await request('initialize', {
    processId: process.pid,
    rootUri: null,
    workspaceFolders: [{ uri: pathToFileURL(projectDir).toString(), name: 'proj' }],
    capabilities: {},
  });
  send({ method: 'initialized', params: {} });
  console.log('initialize: OK');

  const tools = await request('omnetpp/mcp/listTools', {});
  console.log(`omnetpp/mcp/listTools: OK (${tools.length} tools)`);
  if (tools.length < 5) throw new Error('expected several tools');

  // The disk scan runs asynchronously after `initialized`; poll until it lands.
  let types = [];
  for (let i = 0; i < 30 && types.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    types = await request('omnetpp/mcp/callTool', { name: 'list_ned_types', arguments: {} });
  }
  console.log(`list_ned_types (live): OK (${types.length} type(s): ${types.map((t) => t.fqName).join(', ')})`);
  if (types.length === 0) throw new Error('expected indexed disk types from the project');

  // Open an UNSAVED buffer that exists nowhere on disk.
  const liveUri = pathToFileURL(join(projectDir, '__live_only__.ned')).toString();
  send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: liveUri,
        languageId: 'OMNeT++ NED',
        version: 1,
        text: 'simple LiveOnly { parameters: int z = default(7); }',
      },
    },
  });
  // give the server a tick to index the buffer
  await new Promise((r) => setTimeout(r, 200));

  const liveType = await request('omnetpp/mcp/callTool', { name: 'get_ned_type', arguments: { fqName: 'LiveOnly' } });
  if (!liveType || !liveType.params?.some((p) => p.name === 'z')) {
    throw new Error('unsaved buffer not reflected in live index');
  }
  console.log('unsaved-buffer reflection: OK (LiveOnly.z visible without saving)');

  console.log('MCP live-bridge smoke test PASSED');
  server.kill();
  process.exit(0);
} catch (e) {
  console.error('MCP live-bridge smoke test FAILED:', e.message);
  server.kill();
  process.exit(1);
}
