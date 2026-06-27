// For each sample project (a dir tree with .ned + .ini), build the NED index and
// run full INI param resolution, reporting diagnostics to gauge false positives.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sh = require(join(root, 'shared', 'out', 'index.js'));
const wasmDir = join(root, 'resources', 'wasm');

const samplesRoot = resolve(process.argv[2] ?? '/home/rhornig/w/omnetpp-dev/samples');

const svc = await sh.ParserService.create({
  runtimeWasmDir: join(root, 'node_modules', 'web-tree-sitter'),
  nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
  msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
});
const registry = new sh.ConfigRegistry(require(join(root, 'resources', 'config', 'opp-config-options.json')).options);

function walk(dir, ext) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    let s; try { s = statSync(f); } catch { continue; }
    if (s.isDirectory()) out.push(...walk(f, ext));
    else if (n.endsWith(ext)) out.push(f);
  }
  return out;
}

// each immediate subdir of samplesRoot is a project
const projects = readdirSync(samplesRoot)
  .map((n) => join(samplesRoot, n))
  .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });

let totNoMatch = 0, totValType = 0, totKeys = 0;
const samples = [];
for (const proj of projects) {
  const nedFiles = walk(proj, '.ned');
  const iniFiles = walk(proj, '.ini');
  if (!iniFiles.length) continue;
  const cache = new sh.NedResourceCache();
  cache.addFile(sh.BUILTIN_URI, svc.parse('ned', sh.BUILTIN_NED_TEXT), 'ned');
  for (const f of nedFiles) {
    cache.addFile(pathToFileURL(f).toString(), svc.parse('ned', readFileSync(f, 'utf8')), '');
  }
  for (const ini of iniFiles) {
    const doc = sh.parseIni(readFileSync(ini, 'utf8'));
    for (const sec of doc.sections) for (const e of sec.entries)
      if (sh.classifyKey(registry, e.key).kind === 'param-assignment') totKeys++;
    const diags = sh.iniParamDiagnostics(doc, cache, registry);
    for (const d of diags) {
      if (d.code === 'no-matching-param') totNoMatch++;
      else totValType++;
      if (samples.length < 40) samples.push(`${ini.slice(samplesRoot.length + 1)}:${d.range.start.line + 1} [${d.code}] ${d.message}`);
    }
  }
}

console.log(`Projects with ini: scanned. Param-assignment keys: ${totKeys}`);
console.log(`no-matching-param: ${totNoMatch}, param-value-type: ${totValType}`);
for (const s of samples) console.log('  ' + s);
