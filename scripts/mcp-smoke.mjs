// Drives the bundled MCP server (dist/opp_ide_mcp.js) over stdio with a minimal
// MCP handshake, then exercises tools/list and a few tools/call requests against
// a project directory. Validates the real bundled runtime path.
//
// Usage: node scripts/mcp-smoke.mjs [projectDir]   (after `npm run dev:build`)
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(process.argv[2] ?? join(root, 'samples'));

const server = spawn('node', [join(root, 'dist', 'opp_ide_mcp.js'), projectDir], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// MCP's stdio transport frames each JSON-RPC message as a single line of JSON
// terminated by a newline (no Content-Length headers, unlike LSP).
let nextId = 1;
const pending = new Map();
let buf = '';

server.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
      else res(msg.result);
    });
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0' },
  });
  notify('notifications/initialized', {});
  console.log('initialize: OK');

  const tools = await request('tools/list', {});
  console.log(`tools/list: OK (${tools.tools.length} tools)`);
  if (tools.tools.length < 5) throw new Error('expected several tools');

  const list = await request('tools/call', { name: 'list_ned_types', arguments: {} });
  const types = JSON.parse(list.content[0].text);
  console.log(`list_ned_types: OK (${types.length} NED type(s) found)`);

  const opt = await request('tools/call', { name: 'lookup_config_option', arguments: { name: 'sim-time-limit' } });
  console.log(`lookup_config_option: OK (${opt.content[0].text.slice(0, 60).replace(/\n/g, ' ')}...)`);

  console.log('MCP smoke test PASSED');
  server.kill();
  process.exit(0);
} catch (e) {
  console.error('MCP smoke test FAILED:', e.message);
  server.kill();
  process.exit(1);
}
