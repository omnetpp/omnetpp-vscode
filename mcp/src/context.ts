// Shared bootstrap for the standalone disk-index tools (the stdio MCP server
// and the CLI linter): resolve the wasm/config asset dirs next to the bundle,
// create the parser service, build the disk index, and assemble the ToolContext
// the shared tool layer runs against.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParserService, ToolContext, fileUri, normalizeFileUri } from '@omnetpp/shared';
import { NodeFileSystem, splitNedPath } from '@omnetpp/shared/node';
import { buildDiskIndex, DiskIndex } from './indexBuilder.js';

export interface DiskToolSetup {
  ctx: ToolContext;
  index: DiskIndex;
  parsers: ParserService;
  wasmDir: string;
  configDir: string;
}

/**
 * Build everything a disk-index tool needs. `onMissingWasm` is invoked (with a
 * ready-to-print message) when the grammar wasm is absent — the MCP server logs
 * and limps on, the linter exits; the caller decides.
 */
export async function createDiskToolSetup(
  roots: string[],
  nedPathDirs: string[],
  onMissingWasm: (message: string) => void,
): Promise<DiskToolSetup> {
  const wasmDir = process.env.OMNETPP_WASM_DIR || join(__dirname, 'wasm');
  const configDir = process.env.OMNETPP_CONFIG_DIR || join(__dirname, 'config');
  if (!existsSync(join(wasmDir, 'tree-sitter-ned.wasm'))) {
    onMissingWasm(`grammar wasm not found in ${wasmDir}. Run "bun run dev:build" or set OMNETPP_WASM_DIR.`);
  }

  const parsers = await ParserService.create({
    runtimeWasmDir: wasmDir,
    nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
    msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
  });

  const fs = new NodeFileSystem();
  const index = await buildDiskIndex(fs, parsers, configDir, roots, nedPathDirs);

  const ctx: ToolContext = {
    nedCache: index.nedCache,
    msgCache: index.msgCache,
    configRegistry: index.configRegistry,
    db: index.db,
    iniCache: index.iniCache,
    fs,
    parsers,
    toUri: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? normalizeFileUri(p) : fileUri(resolve(p))),
    toPath: (u) => (u.startsWith('file:') ? fileURLToPath(u) : u),
  };

  return { ctx, index, parsers, wasmDir, configDir };
}

/** Split a NED path list (see `splitNedPath`) into absolute directories. */
export function parseNedPathDirs(nedPath: string): string[] {
  return splitNedPath(nedPath).map((s) => resolve(s));
}
