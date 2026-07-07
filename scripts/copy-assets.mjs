// Copies runtime assets into dist/: the language grammar WASM files, the
// web-tree-sitter runtime WASM, and the bundled config-option registry snapshot.
import { existsSync, mkdirSync, copyFileSync, cpSync, readdirSync } from 'node:fs';
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
  console.warn('resources/wasm not found - run "bun run build:wasm" first.');
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

// 4) bundled icon snapshot for the graphical NED preview (gen-icons.mjs)
const iconsSrc = join(root, 'resources', 'icons');
if (existsSync(iconsSrc)) {
  cpSync(iconsSrc, join(dist, 'icons'), { recursive: true });
  console.log(`copied ${iconsSrc} -> ${join(dist, 'icons')}`);
} else {
  console.warn('resources/icons not found - run "bun scripts/gen-icons.mjs <omnetpp-src>" (preview icons will be missing).');
}

// 5) codicons (font + stylesheet) for the eventlog webviews' in-webview
// toolbars (phase U1) -- `dist/webview/codicons/` is loaded via a <link> in
// `webviewHtml.ts`'s buildEventLogWebviewHtml(). @vscode/codicons is a root
// devDependency (package.json), not fetched by any gen-*.mjs script.
const codiconsSrc = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
copyInto(join(codiconsSrc, 'codicon.css'), join(dist, 'webview', 'codicons'));
copyInto(join(codiconsSrc, 'codicon.ttf'), join(dist, 'webview', 'codicons'));

// 6) material neddoc template snapshot (gen-neddoc-material-assets.mjs)
const materialSrc = join(root, 'resources', 'neddoc-material');
if (existsSync(materialSrc)) {
  cpSync(materialSrc, join(dist, 'neddoc-material'), { recursive: true });
  console.log(`copied ${materialSrc} -> ${join(dist, 'neddoc-material')}`);
} else {
  console.warn('resources/neddoc-material not found - run "bun scripts/gen-neddoc-material-assets.mjs <omnetpp-src>" (html-material docs will be unavailable).');
}

console.log('Assets copied.');
