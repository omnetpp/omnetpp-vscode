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
  { entryPoints: ['mcp/src/server.ts'], outfile: 'dist/mcp-server.js' },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('esbuild watching...');
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
  console.log('esbuild bundle complete.');
}
