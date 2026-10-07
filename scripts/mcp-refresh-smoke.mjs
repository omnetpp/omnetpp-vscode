// Drives the bundled MCP server (dist/opp_ide_mcp.js) over stdio against a throwaway
// project and changes files between tool calls, as an agent does: the answers must
// follow added, modified and deleted files, and a project layout change (new
// package.ned). Also checks that the NED path comes from .vscode/settings.json.
//
// Usage: bun scripts/mcp-refresh-smoke.mjs   (after `bun run dev:build`)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'mcp-refresh-'));
const proj = join(tmp, 'proj');
const lib = join(tmp, 'lib');
mkdirSync(join(proj, '.vscode'), { recursive: true });
mkdirSync(lib);
writeFileSync(join(proj, '.vscode', 'settings.json'), '{ "omnetpp.nedPath": "../lib" }');
writeFileSync(join(lib, 'Lib.ned'), 'simple Lib { }\n');
writeFileSync(join(proj, 'A.ned'), 'simple A { parameters: int x; }\n');

const env = { ...process.env };
delete env.OMNETPP_NED_PATH;
const server = spawn(process.execPath, [join(root, 'dist', 'opp_ide_mcp.js'), proj], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env,
});

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

async function typeNames() {
  const r = await request('tools/call', { name: 'list_ned_types', arguments: {} });
  return JSON.parse(r.content[0].text).map((t) => t.fqName ?? t.name).sort();
}

async function params(fqName) {
  const r = await request('tools/call', { name: 'get_ned_type', arguments: { fqName } });
  if (r.isError) return undefined;
  const t = JSON.parse(r.content[0].text);
  return (t?.params ?? []).map((p) => p.name).sort();
}

function expect(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`${label}: OK`);
}

// mtime resolution can be coarse; make every change visibly newer.
const tick = () => new Promise((r) => setTimeout(r, 20));

let failed = false;
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-refresh-smoke', version: '0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const user = (names) => names.filter((n) => ['A', 'B', 'Lib', 'p.C'].includes(n));
  expect('initial types (Lib from the settings NED path)', user(await typeNames()), ['A', 'Lib']);

  await tick();
  writeFileSync(join(proj, 'B.ned'), 'simple B { }\n');
  expect('added file', user(await typeNames()), ['A', 'B', 'Lib']);

  await tick();
  writeFileSync(join(proj, 'A.ned'), 'simple A { parameters: int x; double y; }\n');
  expect('modified file', await params('A'), ['x', 'y']);

  await tick();
  unlinkSync(join(proj, 'B.ned'));
  expect('deleted file', user(await typeNames()), ['A', 'Lib']);

  await tick();
  mkdirSync(join(proj, 'p'));
  writeFileSync(join(proj, 'p', 'package.ned'), 'package p;\n');
  writeFileSync(join(proj, 'p', 'C.ned'), 'package p;\nsimple C { }\n');
  expect('new package (layout change)', user(await typeNames()), ['A', 'Lib', 'p.C']);

  console.log('MCP REFRESH SMOKE PASSED');
} catch (e) {
  console.error('MCP REFRESH SMOKE FAILED:', e.message);
  failed = true;
} finally {
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
