// Builds the tree-sitter WASM grammars from the submodules and copies them into
// resources/wasm/. Requires emscripten (emcc) or docker on PATH (used by tree-sitter
// `build --wasm`). The produced .wasm files are loaded at runtime via web-tree-sitter.
//
// This script is node-free: it invokes the native `tree-sitter` binary (a Rust
// executable) directly, and downloads that binary itself with `fetch` if it is
// missing. We do NOT rely on tree-sitter-cli's npm `install` postinstall (which is
// `node install.js`), so it is left untrusted/unrun in package.json and the whole
// build runs under bun without a Node.js install.
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, readFileSync, realpathSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'resources', 'wasm');
mkdirSync(outDir, { recursive: true });

// Resolve the tree-sitter-cli package dir from its .bin entry (created from the
// package's "bin" field regardless of whether the postinstall ran).
const tsPkgDir = dirname(realpathSync(join(root, 'node_modules', '.bin', 'tree-sitter')));
const tsBinary = join(tsPkgDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');

await ensureTreeSitterBinary();

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
  execFileSync(tsBinary, ['build', '--wasm', '-o', wasm], { cwd: g.dir, stdio: 'inherit' });
  copyFileSync(wasm, join(outDir, `${g.name}.wasm`));
  console.log(`  -> ${join(outDir, `${g.name}.wasm`)}`);
}
console.log('WASM grammars built.');

// Download the prebuilt native tree-sitter binary for this platform if it is not
// already present (the npm postinstall that would normally do this is left unrun so
// `bun install` needs no Node.js). Uses fetch, which follows GitHub's redirect.
async function ensureTreeSitterBinary() {
  if (existsSync(tsBinary)) return;
  const version = JSON.parse(readFileSync(join(tsPkgDir, 'package.json'), 'utf8')).version;
  const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64', arm: 'arm', ia32: 'x86' }[process.arch];
  if (!platform || !arch) {
    throw new Error(`no tree-sitter binary mapping for ${process.platform}/${process.arch}`);
  }
  const url = `https://github.com/tree-sitter/tree-sitter/releases/download/v${version}/tree-sitter-${platform}-${arch}.gz`;
  console.log(`tree-sitter binary not found - downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download tree-sitter binary: HTTP ${res.status}`);
  writeFileSync(tsBinary, gunzipSync(Buffer.from(await res.arrayBuffer())));
  chmodSync(tsBinary, 0o755);
  console.log(`  -> installed ${tsBinary}`);
}
