// Copies runtime assets into dist/: the language grammar WASM files, the
// web-tree-sitter runtime WASM, and the bundled config-option registry snapshot.
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

function copyInto(src, destDir, destName) {
  if (!existsSync(src)) {
    console.error(`Asset not found: ${src}`);
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, destName ?? src.split('/').pop());
  copyFileSync(src, dest);
  console.log(`copied ${src} -> ${dest}`);
}

// 1) grammar wasm files (built by build-wasm.mjs)
const wasmSrc = join(root, 'resources', 'wasm');
if (existsSync(wasmSrc)) {
  for (const f of readdirSync(wasmSrc)) {
    if (f.endsWith('.wasm')) copyInto(join(wasmSrc, f), join(dist, 'wasm'), f);
  }
} else {
  console.warn('resources/wasm not found - run "npm run build:wasm" first.');
}

// 2) web-tree-sitter runtime wasm
copyInto(
  join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
  join(dist, 'wasm'),
  'tree-sitter.wasm'
);

// 3) bundled config snapshots (config options + msg builtins)
const configSrc = join(root, 'resources', 'config');
for (const f of readdirSync(configSrc)) {
  if (f.endsWith('.json')) copyInto(join(configSrc, f), join(dist, 'config'), f);
}

console.log('Assets copied.');
