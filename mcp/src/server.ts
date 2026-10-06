// Standalone MCP server exposing the OMNeT++ NED/MSG/INI semantic model over
// stdio. Builds a project index from disk (via @omnetpp/shared) and answers the
// shared tool layer's queries. The runtime artifact is dist/opp_ide_mcp.js
// (produced by esbuild); assets (wasm/, config/) live next to it, as for the LSP
// server bundle.
//
// Usage:  opp_ide_mcp [projectDir ...] [--ned-path=a;b]
// Env:    OMNETPP_NED_PATH, OMNETPP_WASM_DIR, OMNETPP_CONFIG_DIR
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMNETPP_TOOLS, handleTool } from '@omnetpp/shared';
import { ELOG_TOOLS, handleElogTool, type ElogToolContext } from '@omnetpp/shared/elog-tools';
import { NodeRandomAccessFileProvider } from '@omnetpp/shared/node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDiskToolSetup, parseNedPathDirs } from './context.js';

/** Injected by esbuild from package.json. */
declare const __OPP_VERSION__: string;

/** Log to stderr only — stdout is reserved for the JSON-RPC stdio transport. */
function log(...args: unknown[]): void {
  console.error('[opp_ide_mcp]', ...args);
}

const USAGE = `opp_ide_mcp — MCP stdio server for the OMNeT++ NED/MSG/INI model and eventlogs

Usage:
  opp_ide_mcp [options] [projectDir ...]

Speaks the Model Context Protocol (newline-delimited JSON-RPC) on stdin/stdout;
start it from an MCP client, not interactively. Logs go to stderr.

Arguments:
  projectDir          Project directories to index. Defaults to the current directory.

Options:
  --ned-path=<dirs>   Extra NED source roots (libraries), ';'-separated
                      (or ':' outside Windows).
                      Defaults to the OMNETPP_NED_PATH environment variable.
  -h, --help          Show this help.`;

function parseArgs(argv: string[]): { roots: string[]; nedPathDirs: string[] } {
  const roots: string[] = [];
  let nedPath = process.env.OMNETPP_NED_PATH ?? '';
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a.startsWith('--ned-path=')) nedPath = a.slice('--ned-path='.length);
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

  // The elog tools are a fully independent feature (query any .elog file on disk by
  // path, no relation to the NED/MSG/INI project index above), so their context is
  // just a RandomAccessFileProvider + a path resolver -- no disk indexing at startup.
  const elogCtx: ElogToolContext = {
    fileProvider: new NodeRandomAccessFileProvider(),
    resolvePath: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? fileURLToPath(p) : resolve(p)),
  };
  log(`${ELOG_TOOLS.length} elog tool(s) available`);

  const server = new Server(
    { name: 'omnetpp-ned-msg-ini', version: __OPP_VERSION__ },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...OMNETPP_TOOLS, ...ELOG_TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = req.params.name.startsWith('elog_')
        ? handleElogTool(req.params.name, req.params.arguments ?? {}, elogCtx)
        : await handleTool(req.params.name, req.params.arguments ?? {}, ctx);
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
