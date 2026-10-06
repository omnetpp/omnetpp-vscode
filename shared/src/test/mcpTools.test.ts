import { test } from 'bun:test';
import assert from 'node:assert';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  SemanticDatabase,
  IniResourceCache,
  handleTool,
  OMNETPP_TOOLS,
  ToolContext,
} from '../index';
import type { FileSystem, FileStat } from '../fs/fileSystem';

const NED_FILES: Record<string, string> = {
  'file:///proj/Host.ned': 'simple Host { parameters: int numApps = default(2); string mode; }',
  'file:///proj/Server.ned': 'simple Server extends Host { parameters: int threads = default(4); }',
  'file:///proj/Net.ned': 'network Net { submodules: host: Host; srv: Server; }',
};

const INI_PATH = '/proj/omnetpp.ini';
const INI_TEXT = `[General]
network = Net

[Config Fast]
**.host.mode = "fast"
`;

/** Minimal in-memory FileSystem holding just the ini file. */
const memFs: FileSystem = {
  async readFile(path: string): Promise<string> {
    if (path === INI_PATH) return INI_TEXT;
    throw new Error(`ENOENT: ${path}`);
  },
  async readDirectory(): Promise<string[]> {
    return [];
  },
  async stat(): Promise<FileStat> {
    return { isFile: true, isDirectory: false };
  },
  async exists(path: string): Promise<boolean> {
    return path === INI_PATH;
  },
};

async function buildCtx(): Promise<ToolContext> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const configRegistry = new ConfigRegistry([
    { name: 'sim-time-limit', type: 'double', unit: 's', default: null, scope: 'global', description: 'Simulation time limit.' },
  ]);
  const iniCache = new IniResourceCache();
  const db = new SemanticDatabase(nedCache, msgCache, configRegistry, iniCache);
  // mirror ProjectIndex: add to the cache, then index its cross-references
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  db.onNedFile(BUILTIN_URI);
  for (const [uri, text] of Object.entries(NED_FILES)) {
    nedCache.addFile(uri, svc.parse('ned', text), '');
    db.onNedFile(uri);
  }
  iniCache.addFile(pathToFileURL(INI_PATH).toString(), INI_TEXT);
  db.onIniFile(pathToFileURL(INI_PATH).toString());
  return {
    nedCache,
    msgCache,
    configRegistry,
    db,
    iniCache,
    fs: memFs,
    parsers: svc,
    toUri: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : pathToFileURL(p).toString()),
    toPath: (u) => (u.startsWith('file:') ? fileURLToPath(u) : u),
  };
}

test('OMNETPP_TOOLS exposes the documented tool set', () => {
  const names = OMNETPP_TOOLS.map((t) => t.name);
  for (const expected of ['list_ned_types', 'get_ned_type', 'resolve_ini_params', 'lookup_config_option', 'rename_ned_type']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // every tool must carry a JSON schema
  for (const t of OMNETPP_TOOLS) assert.equal((t.inputSchema as any).type, 'object');
  for (const expected of ['impact_of', 'find_unused', 'neighbors']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test('impact_of returns the transitive dependents of a type', async () => {
  const ctx = await buildCtx();
  const r = (await handleTool('impact_of', { fqName: 'Host' }, ctx)) as any[];
  const names = r.map((n) => n.name);
  assert.ok(names.includes('Server'), 'Server extends Host');
  assert.ok(names.includes('Net'), 'Net instantiates Host');
  // every dependent carries the relation + depth
  assert.ok(r.every((n) => typeof n.via === 'string' && typeof n.depth === 'number'));
});

test('find_unused reports no unused network when a config runs it', async () => {
  const ctx = await buildCtx();
  const r = (await handleTool('find_unused', {}, ctx)) as any;
  assert.deepEqual(r.unusedNetworks, []); // Net is run by [General] network=Net
  assert.deepEqual(r.orphanMsgTypes, []); // no MSG types in the fixture
});

test('neighbors returns inbound and outbound graph edges', async () => {
  const ctx = await buildCtx();
  const inbound = (await handleTool('neighbors', { fqName: 'Host', direction: 'in' }, ctx)) as any[];
  const kinds = new Set(inbound.map((e) => e.kind));
  assert.ok(kinds.has('extends'), 'Server extends Host');
  assert.ok(kinds.has('submodule-type'), 'Net has a Host submodule');

  const out = (await handleTool('neighbors', { fqName: 'Server', direction: 'out', kinds: ['extends'] }, ctx)) as any[];
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'extends');
  assert.equal(out[0].direction, 'out');
});

test('list_ned_types excludes builtins and supports filters', async () => {
  const ctx = await buildCtx();
  const all = (await handleTool('list_ned_types', {}, ctx)) as any[];
  const fqNames = all.map((t) => t.fqName);
  assert.ok(fqNames.includes('Net') && fqNames.includes('Host') && fqNames.includes('Server'));
  assert.ok(!fqNames.some((n: string) => n.startsWith('ned.')), 'builtins excluded by default');

  const networks = (await handleTool('list_ned_types', { kind: 'network' }, ctx)) as any[];
  assert.deepEqual(networks.map((t) => t.fqName), ['Net']);
});

test('get_ned_type returns merged members and inheritance', async () => {
  const ctx = await buildCtx();
  const host = (await handleTool('get_ned_type', { fqName: 'Host' }, ctx)) as any;
  assert.equal(host.kind, 'simple');
  assert.deepEqual(
    host.params.map((p: any) => p.name).sort(),
    ['mode', 'numApps'],
  );

  const server = (await handleTool('get_ned_type', { fqName: 'Server' }, ctx)) as any;
  // inherits Host's params plus its own
  assert.deepEqual(server.params.map((p: any) => p.name).sort(), ['mode', 'numApps', 'threads']);
  assert.deepEqual(server.ancestors, ['Host']);

  const net = (await handleTool('get_ned_type', { fqName: 'Net' }, ctx)) as any;
  assert.equal(net.isNetwork, true);
  assert.deepEqual(net.submodules.map((s: any) => s.name).sort(), ['host', 'srv']);
});

test('find_subtypes and get_inheritance', async () => {
  const ctx = await buildCtx();
  const subs = (await handleTool('find_subtypes', { fqName: 'Host' }, ctx)) as any[];
  assert.deepEqual(subs.map((t) => t.fqName), ['Server']);

  const inh = (await handleTool('get_inheritance', { fqName: 'Server' }, ctx)) as any;
  assert.deepEqual(inh.ancestors, ['Host']);
});

test('list_ini_configs reports configs with effective network', async () => {
  const ctx = await buildCtx();
  const configs = (await handleTool('list_ini_configs', { uri: INI_PATH }, ctx)) as any[];
  const fast = configs.find((c) => c.name === 'Fast');
  assert.ok(fast, 'Config Fast present');
  assert.equal(fast.network, 'Net');
});

test('resolve_ini_params classifies value sources', async () => {
  const ctx = await buildCtx();
  const res = (await handleTool('resolve_ini_params', { uri: INI_PATH, config: 'Fast' }, ctx)) as any;
  assert.equal(res.resolved, true);
  assert.equal(res.network, 'Net');

  const mode = res.params.find((p: any) => p.path === 'Net.host.mode');
  assert.ok(mode, 'Net.host.mode slot present');
  assert.equal(mode.source, 'ini');
  assert.equal(mode.value, '"fast"');
  assert.equal(mode.assignedBy, '**.host.mode');

  const numApps = res.params.find((p: any) => p.path === 'Net.host.numApps');
  assert.ok(numApps);
  assert.equal(numApps.source, 'ned-default');
});

test('lookup_config_option and list_config_options', async () => {
  const ctx = await buildCtx();
  const opt = (await handleTool('lookup_config_option', { name: 'sim-time-limit' }, ctx)) as any;
  assert.equal(opt.scope, 'global');
  assert.equal(opt.unit, 's');

  const missing = await handleTool('lookup_config_option', { name: 'no-such-option' }, ctx);
  assert.equal(missing, null);

  const all = (await handleTool('list_config_options', { scope: 'global' }, ctx)) as any[];
  assert.equal(all.length, 1);
});

test('rename_ned_type edits declaration and references', async () => {
  const ctx = await buildCtx();
  const edit = (await handleTool('rename_ned_type', { fqName: 'Host', newName: 'Node' }, ctx)) as any;
  const files = Object.keys(edit.changes);
  // declaration in Host.ned, plus references in Server.ned (extends) and Net.ned (submodule type)
  assert.ok(files.includes('file:///proj/Host.ned'));
  assert.ok(files.includes('file:///proj/Server.ned'));
  assert.ok(files.includes('file:///proj/Net.ned'));
  for (const edits of Object.values(edit.changes) as any[]) {
    for (const e of edits) assert.equal(e.newText, 'Node');
  }
});

test('rename_member renames a parameter project-wide', async () => {
  const ctx = await buildCtx();
  const edit = (await handleTool('rename_member', { typeFqName: 'Host', member: 'numApps', newName: 'count' }, ctx)) as any;
  assert.ok(edit.changes && Object.keys(edit.changes).length >= 1);
  for (const edits of Object.values(edit.changes) as any[]) {
    for (const e of edits) assert.equal(e.newText, 'count');
  }
});

const INI_URI = pathToFileURL(INI_PATH).toString();
const editedText = (edits: any[], line: number) =>
  edits.filter((e) => e.range.start.line === line).map((e) => {
    const src = INI_TEXT.split('\n')[line];
    return src.slice(0, e.range.start.character) + e.newText + src.slice(e.range.end.character);
  });

test('rename_ned_type also rewrites INI network= values', async () => {
  const ctx = await buildCtx();
  const edit = (await handleTool('rename_ned_type', { fqName: 'Net', newName: 'Lan' }, ctx)) as any;
  assert.ok(edit.changes['file:///proj/Net.ned'], 'declaration');
  assert.deepEqual(editedText(edit.changes[INI_URI] ?? [], 1), ['network = Lan']);
});

test('rename_member of a parameter also rewrites INI assignment keys', async () => {
  const ctx = await buildCtx();
  const edit = (await handleTool('rename_member', { typeFqName: 'Host', member: 'mode', newName: 'style' }, ctx)) as any;
  assert.ok(edit.changes['file:///proj/Host.ned'], 'declaration');
  assert.deepEqual(editedText(edit.changes[INI_URI] ?? [], 4), ['**.host.style = "fast"']);
});

test('rename_member of an inherited parameter uses its canonical owner', async () => {
  const ctx = await buildCtx();
  // Server inherits mode from Host; the INI key targets host (a Host), so it must still be found
  const edit = (await handleTool('rename_member', { typeFqName: 'Server', member: 'mode', newName: 'style' }, ctx)) as any;
  assert.deepEqual(editedText(edit.changes[INI_URI] ?? [], 4), ['**.host.style = "fast"']);
});

test('get_diagnostics flags a malformed NED file', async () => {
  const ctx = await buildCtx();
  // add a file with a syntax error directly to the cache
  const svc = await getParsers();
  ctx.nedCache.addFile('file:///proj/Bad.ned', svc.parse('ned', 'simple Bad { parameters: int n = ; }'), '');
  const res = (await handleTool('get_diagnostics', { uri: 'file:///proj/Bad.ned' }, ctx)) as any;
  assert.ok(res.diagnostics.length >= 1, 'expected at least one diagnostic');
});

test('unknown tool rejects', async () => {
  const ctx = await buildCtx();
  await assert.rejects(() => Promise.resolve(handleTool('nope', {}, ctx)));
});

test('find_param_assignments (reverse INI) finds the INI key that sets a NED param', async () => {
  const ctx = await buildCtx();
  const rows = (await handleTool('find_param_assignments', { typeFqName: 'Host', param: 'mode' }, ctx)) as any[];
  assert.ok(rows.length >= 1, 'expected at least one assignment');
  const r = rows.find((x) => x.matchedPath === 'Net.host.mode');
  assert.ok(r, `expected Net.host.mode, got ${JSON.stringify(rows)}`);
  assert.equal(r.key, '**.host.mode');
  assert.equal(r.config, 'Fast');
});

test('get_connections returns an array for a network', async () => {
  const ctx = await buildCtx();
  const conns = (await handleTool('get_connections', { fqName: 'Net' }, ctx)) as any[];
  assert.ok(Array.isArray(conns));
});

test('new tools are advertised in OMNETPP_TOOLS', () => {
  const names = OMNETPP_TOOLS.map((t) => t.name);
  for (const n of ['find_param_assignments', 'get_connections', 'find_msg_usages', 'resolve_class']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});
