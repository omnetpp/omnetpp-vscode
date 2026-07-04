// Standalone MCP server exposing the OMNeT++ NED/MSG/INI semantic model over
// stdio. Builds a project index from disk (via @omnetpp/shared) and answers the
// shared tool layer's queries. The runtime artifact is dist/opp_ide_mcp.js
// (produced by esbuild); assets (wasm/, config/) live next to it, as for the LSP
// server bundle.
//
// Usage:  node dist/opp_ide_mcp.js [projectDir ...] [--ned-path=a;b]
// Env:    OMNETPP_NED_PATH, OMNETPP_WASM_DIR, OMNETPP_CONFIG_DIR
import { resolve } from 'node:path';
import { OMNETPP_TOOLS, handleTool } from '@omnetpp/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDiskToolSetup, parseNedPathDirs } from './context.js';

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
  return { roots, nedPathDirs: parseNedPathDirs(nedPath) };
}

async function main(): Promise<void> {
  const { roots, nedPathDirs } = parseArgs(process.argv.slice(2));

  // A missing grammar wasm is not fatal here: report it and limp on.
  const { ctx, index } = await createDiskToolSetup(roots, nedPathDirs, log);
  log(
    `indexed ${index.nedCache.allTypes().length} NED type(s), ` +
      `${index.msgCache.allTypes().length} MSG type(s) from: ${roots.join(', ')}`,
  );

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
