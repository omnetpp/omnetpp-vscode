// Standalone MCP server exposing the OMNeT++ NED/MSG/INI semantic model over
// stdio. Builds a project index from disk (via @omnetpp/shared) and answers the
// shared tool layer's queries. The runtime artifact is dist/opp_ide_mcp.js
// (produced by esbuild); assets (wasm/, config/) live next to it, as for the LSP
// server bundle.
//
// Usage:  node dist/opp_ide_mcp.js [projectDir ...] [--ned-path=a;b]
// Env:    OMNETPP_NED_PATH, OMNETPP_WASM_DIR, OMNETPP_CONFIG_DIR
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ParserService, OMNETPP_TOOLS, handleTool, ToolContext } from '@omnetpp/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NodeFileSystem } from '@omnetpp/shared/node';
import { buildDiskIndex } from './indexBuilder.js';

/** Log to stderr only — stdout is reserved for the JSON-RPC stdio transport. */
function log(...args: unknown[]): void {
  console.error('[opp_ide_mcp]', ...args);
}

function parseArgs(argv: string[]): { roots: string[]; nedPathDirs: string[] } {
  const roots: string[] = [];
  let nedPath = process.env.OMNETPP_NED_PATH ?? '';
  for (const a of argv) {
    if (a.startsWith('--ned-path=')) nedPath = a.slice('--ned-path='.length);
    else if (a.startsWith('--')) continue;
    else roots.push(resolve(a));
  }
  if (!roots.length) roots.push(process.cwd());
  const nedPathDirs = nedPath
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));
  return { roots, nedPathDirs };
}

async function main(): Promise<void> {
  const { roots, nedPathDirs } = parseArgs(process.argv.slice(2));

  const wasmDir = process.env.OMNETPP_WASM_DIR || join(__dirname, 'wasm');
  const configDir = process.env.OMNETPP_CONFIG_DIR || join(__dirname, 'config');
  if (!existsSync(join(wasmDir, 'tree-sitter-ned.wasm'))) {
    log(`grammar wasm not found in ${wasmDir}. Run "bun run dev:build" or set OMNETPP_WASM_DIR.`);
  }

  const parsers = await ParserService.create({
    runtimeWasmDir: wasmDir,
    nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
    msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
  });

  const fs = new NodeFileSystem();
  const index = await buildDiskIndex(fs, parsers, configDir, roots, nedPathDirs);
  log(
    `indexed ${index.nedCache.allTypes().length} NED type(s), ` +
      `${index.msgCache.allTypes().length} MSG type(s) from: ${roots.join(', ')}`,
  );

  const ctx: ToolContext = {
    nedCache: index.nedCache,
    msgCache: index.msgCache,
    configRegistry: index.configRegistry,
    db: index.db,
    iniCache: index.iniCache,
    fs,
    parsers,
    toUri: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : pathToFileURL(resolve(p)).toString()),
    toPath: (u) => (u.startsWith('file:') ? fileURLToPath(u) : u),
  };

  const server = new Server(
    { name: 'omnetpp-ned-msg-ini', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OMNETPP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await handleTool(req.params.name, req.params.arguments ?? {}, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
  log('ready (stdio)');
}

main().catch((e) => {
  log('fatal:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
