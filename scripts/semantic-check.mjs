// Builds a NED index over a project dir and reports semantic diagnostics, to
// measure false-positive rate against real code. Usage:
//   node scripts/semantic-check.mjs <projectDir>
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shared = require(join(root, 'shared', 'out', 'index.js'));
const {
  ParserService,
  NedResourceCache,
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  nedSemanticDiagnostics,
  discoverProjectLayout,
  packageForFile,
  isExcludedPackage,
} = shared;

const projectDir = resolve(process.argv[2] ?? '/home/rhornig/w/omnetpp-dev/samples');
const wasmDir = join(root, 'resources', 'wasm');

const svc = await ParserService.create({
  runtimeWasmDir: join(root, 'node_modules', 'web-tree-sitter'),
  nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
  msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
});

// FileSystem shim for project model
const fs = {
  readFile: async (p) => readFileSync(p, 'utf8'),
  readDirectory: async (p) => readdirSync(p),
  stat: async (p) => {
    const s = statSync(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory() };
  },
  exists: async (p) => {
    try { statSync(p); return true; } catch { return false; }
  },
};

const layout = await discoverProjectLayout(fs, [projectDir], []);
const cache = new NedResourceCache();
cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');

const nedFiles = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'out') continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full);
    else if (name.endsWith('.ned')) nedFiles.push(full);
  }
}
walk(projectDir);

for (const f of nedFiles) {
  const pkg = packageForFile(layout.roots, f);
  if (pkg && isExcludedPackage(layout.excludedPackages, pkg)) continue;
  cache.addFile(pathToFileURL(f).toString(), svc.parse('ned', readFileSync(f, 'utf8')), pkg);
}

let totalDiags = 0;
const byCode = {};
const samples = [];
for (const f of nedFiles) {
  const uri = pathToFileURL(f).toString();
  const diags = nedSemanticDiagnostics(cache, uri);
  totalDiags += diags.length;
  for (const d of diags) {
    byCode[d.code] = (byCode[d.code] ?? 0) + 1;
    if (samples.length < 50) samples.push(`${f.slice(projectDir.length + 1)}:${d.range.start.line + 1} [${d.code}] ${d.message}`);
  }
}

console.log(`Indexed ${cache.allTypeNames().length} NED types from ${nedFiles.length} files.`);
console.log(`Semantic diagnostics: ${totalDiags}`, byCode);
for (const s of samples) console.log('  ' + s);
