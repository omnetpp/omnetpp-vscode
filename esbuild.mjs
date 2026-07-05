// Bundles the extension client and the language server into dist/ with esbuild.
// web-tree-sitter (and its emscripten glue) is bundled too; the runtime
// tree-sitter.wasm and grammar .wasm files are copied separately (copy-assets.mjs)
// and located at runtime via an absolute path / locateFile.
import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  external: ['vscode'],
  logLevel: 'info',
};

const targets = [
  { entryPoints: ['client/src/extension.ts'], outfile: 'dist/extension.js' },
  { entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js' },
  { entryPoints: ['mcp/src/server.ts'], outfile: 'dist/opp_ide_mcp.js' },
  // standalone CLI linter — runnable directly (node shebang) and via the `bin` entry
  { entryPoints: ['mcp/src/lint.ts'], outfile: 'dist/opp_lint.js', banner: { js: '#!/usr/bin/env node' } },
  // the NED preview webview app: a browser IIFE (loaded via <script> in the
  // webview; imports only @omnetpp/shared/preview — no tree-sitter, no Node APIs)
  {
    entryPoints: ['client/webview/src/main.ts'],
    outfile: 'dist/webview/nedPreview.js',
    platform: 'browser',
    target: 'es2021',
    format: 'iife',
    external: [],
  },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('esbuild watching...');
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
  console.log('esbuild bundle complete.');
}
