import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { OMNETPP_TOOLS, handleTool, OmnetppMethods } from '@omnetpp/shared';
import type { FileSystem, McpCallToolParams, ToolContext } from '@omnetpp/shared';
import { NodeFileSystem } from '@omnetpp/shared/node';
import { ServerState } from './serverState';

/**
 * Registers the MCP live-index bridge: the extension hosts an MCP HTTP endpoint
 * and forwards tool calls here, so MCP clients query the SAME live index the
 * editor uses (reflecting unsaved buffers).
 */
export function registerMcpRequests(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  state: ServerState,
): void {
  const mcpNodeFs = new NodeFileSystem();
  /** FileSystem that serves open editor buffers first, falling back to disk. */
  const mcpLiveFs: FileSystem = {
    async readFile(path) {
      const doc = documents.get(pathToFileURL(path).toString());
      return doc ? doc.getText() : mcpNodeFs.readFile(path);
    },
    readDirectory: (p) => mcpNodeFs.readDirectory(p),
    stat: (p) => mcpNodeFs.stat(p),
    exists: (p) => mcpNodeFs.exists(p),
  };

  function mcpCtx(): ToolContext | undefined {
    if (!state.index || !state.parsers) return undefined;
    return {
      nedCache: state.index.cache,
      msgCache: state.index.msgCache,
      configRegistry: state.index.configRegistry,
      db: state.index.db,
      iniCache: state.index.iniCache,
      fs: mcpLiveFs,
      parsers: state.parsers,
      toUri: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : pathToFileURL(p).toString()),
      toPath: (u) => (u.startsWith('file:') ? fileURLToPath(u) : u),
    };
  }

  connection.onRequest(OmnetppMethods.mcpListTools, () => OMNETPP_TOOLS);

  connection.onRequest(OmnetppMethods.mcpCallTool, async (params: McpCallToolParams) => {
    const c = mcpCtx();
    if (!c) throw new Error('OMNeT++ project index not ready');
    return handleTool(params.name, params.arguments ?? {}, c);
  });
}
