// Bundles the extension client and the language server into dist/ with esbuild.
// web-tree-sitter (and its emscripten glue) is bundled too; the runtime
// tree-sitter.wasm and grammar .wasm files are copied separately (copy-assets.mjs)
// and located at runtime via an absolute path / locateFile.
import { readFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('esbuild').BuildOptions} */
export const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  external: ['vscode'],
  logLevel: 'info',
  // Single source of truth for the version the bundles report (e.g. MCP server info).
  define: { __OPP_VERSION__: JSON.stringify(version) },
};

export const targets = [
  { entryPoints: ['client/src/extension.ts'], outfile: 'dist/extension.js' },
  { entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js' },
  // standalone MCP stdio server
  { entryPoints: ['mcp/src/server.ts'], outfile: 'dist/opp_ide_mcp.js', banner: { js: '#!/usr/bin/env node' } },
  // standalone CLI linter — runnable directly (node shebang) and via the `bin` entry
  { entryPoints: ['mcp/src/lint.ts'], outfile: 'dist/opp_lint.js', banner: { js: '#!/usr/bin/env node' } },
  // standalone CLI documentation generator
  { entryPoints: ['mcp/src/neddoc.ts'], outfile: 'dist/opp_neddoc.js', banner: { js: '#!/usr/bin/env node' } },
  // the dedicated per-.elog eventlog worker process (client/worker/): a single CJS
  // bundle re-entered both as the main process script (JSON-RPC over stdio) and,
  // via `new Worker(__filename)`, as its own engine worker_thread -- see
  // client/worker/src/main.ts's header for the isMainThread-guarded re-entry.
  { entryPoints: ['client/worker/src/main.ts'], outfile: 'dist/eventlogWorker.js' },
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
  // the Sequence Chart custom editor + Event Log table view webview apps
  // (phase U1): browser IIFEs, same shape as the NED preview target above.
  // They import only @omnetpp/shared/elog-protocol and @omnetpp/shared/ui-protocol
  // (DTOs + a couple of small, dependency-free enums — never the eventlog
  // engine barrel), so the bundle stays free of the parser/FileReader/etc.
  {
    entryPoints: ['client/webview/src/eventlog/chart/chartMain.ts'],
    outfile: 'dist/webview/sequenceChart.js',
    platform: 'browser',
    target: 'es2021',
    format: 'iife',
    external: [],
  },
  {
    entryPoints: ['client/webview/src/eventlog/table/tableMain.ts'],
    outfile: 'dist/webview/eventLogTable.js',
    platform: 'browser',
    target: 'es2021',
    format: 'iife',
    external: [],
  },
];

// Imported (not run) by scripts/gen-third-party-notices.mjs, which needs the same targets.
if (import.meta.main) {
  if (watch) {
    const ctxs = await Promise.all(targets.map((t) => context({ ...common, ...t })));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild watching...');
  } else {
    await Promise.all(targets.map((t) => build({ ...common, ...t })));
    console.log('esbuild bundle complete.');
  }
}
