// Diagnostic: for each sample network, print the module-hierarchy root's children
// and whether each reports hasChildren (i.e. should show an expand arrow).
import { readdirSync, statSync, readFileSync } from 'node:fs';
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
function walk(dir, ext) {
  const o = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    let s; try { s = statSync(f); } catch { continue; }
    if (s.isDirectory()) o.push(...walk(f, ext));
    else if (n.endsWith(ext)) o.push(f);
  }
  return o;
}
const cache = new sh.NedResourceCache();
cache.addFile(sh.BUILTIN_URI, svc.parse('ned', sh.BUILTIN_NED_TEXT), 'ned');
for (const f of walk(samplesRoot, '.ned')) {
  cache.addFile(pathToFileURL(f).toString(), svc.parse('ned', readFileSync(f, 'utf8')), '');
}
let withArrow = 0, total = 0, printed = 0;
for (const t of cache.allTypes()) {
  if (t.isInnerType || t.kind !== 'network') continue;
  const r = sh.moduleHierarchyRoot(cache, t);
  if (!r.children.length) continue;
  for (const c of r.children) {
    total++;
    if (c.hasChildren) withArrow++;
  }
  if (printed < 12 && r.children.some((c) => c.hasChildren)) {
    printed++;
    console.log(`network ${t.simpleName}:`);
    for (const c of r.children)
      console.log(`  ${c.label}  type=${c.typeFqName ?? '?'}  like=${!!c.isLike}  hasChildren=${c.hasChildren}`);
  }
}
console.log(`\nroot-child nodes: ${total}, with expand arrow (hasChildren): ${withArrow}`);
