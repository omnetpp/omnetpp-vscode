// Parses every .ned/.msg file under the given corpus directory with the WASM
// grammars and reports files containing ERROR/MISSING nodes. Usage:
//   node scripts/smoke-test.mjs [corpusDir]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { ParserService, collectSyntaxErrors } = require(join(root, 'shared', 'out', 'index.js'));

const corpus = resolve(process.argv[2] ?? '/home/rhornig/w/omnetpp-dev/samples');
const wasmDir = join(root, 'resources', 'wasm');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(ned|msg)$/.test(name)) yield p;
  }
}

const runtimeWasmDir = join(root, 'node_modules', 'web-tree-sitter');
const svc = await ParserService.create({
  runtimeWasmDir,
  nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
  msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
});

let total = 0;
let failed = 0;
const failures = [];
for (const file of walk(corpus)) {
  total++;
  const grammar = file.endsWith('.ned') ? 'ned' : 'msg';
  const text = readFileSync(file, 'utf8');
  const tree = svc.parse(grammar, text);
  const errs = collectSyntaxErrors(tree);
  if (errs.length) {
    failed++;
    failures.push({ file: file.slice(corpus.length + 1), errors: errs.length, first: errs[0].startPosition });
  }
}

console.log(`Parsed ${total} files; ${failed} with parse errors.`);
for (const f of failures.slice(0, 40)) {
  console.log(`  ${f.file}: ${f.errors} error(s), first at line ${f.first.row + 1}`);
}
if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
process.exit(failed > 0 ? 1 : 0);
