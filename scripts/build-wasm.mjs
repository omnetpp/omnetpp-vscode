// Builds the tree-sitter WASM grammars from the submodules and copies them into
// resources/wasm/. Requires emscripten (emcc) or docker on PATH (used by tree-sitter
// build-wasm). The produced .wasm files are loaded at runtime via web-tree-sitter.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsCli = join(root, 'node_modules', '.bin', 'tree-sitter');
const outDir = join(root, 'resources', 'wasm');
mkdirSync(outDir, { recursive: true });

const grammars = [
  { name: 'tree-sitter-ned', dir: join(root, 'subprojects', 'tree-sitter-ned') },
  { name: 'tree-sitter-msg', dir: join(root, 'subprojects', 'tree-sitter-msg') },
];

for (const g of grammars) {
  if (!existsSync(join(g.dir, 'grammar.js'))) {
    console.error(`Missing grammar at ${g.dir} - did you run refresh_submodules?`);
    process.exit(1);
  }
  console.log(`Building ${g.name} WASM...`);
  // tree-sitter-cli >= 0.22 replaced `build-wasm` with `build --wasm`. Without `-o`
  // it names the output after the grammar in tree-sitter.json (e.g. omnetpp-ned.wasm),
  // so pass an explicit path to keep the tree-sitter-<lang>.wasm filenames.
  const wasm = join(g.dir, `${g.name}.wasm`);
  execFileSync(tsCli, ['build', '--wasm', '-o', wasm], { cwd: g.dir, stdio: 'inherit' });
  copyFileSync(wasm, join(outDir, `${g.name}.wasm`));
  console.log(`  -> ${join(outDir, `${g.name}.wasm`)}`);
}
console.log('WASM grammars built.');
