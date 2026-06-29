// Hosts a local Streamable-HTTP MCP endpoint inside the extension host and
// forwards every tool call to the running language server, so MCP clients query
// the SAME live project index the editor uses (reflecting unsaved buffers).
//
// The endpoint is bound to 127.0.0.1 on an ephemeral port and guarded by a
// per-session bearer token (passed to VS Code via the server definition headers)
// so other local processes cannot reach it.
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Uri } from 'vscode';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LanguageClient } from 'vscode-languageclient/node';

export interface McpBridge {
  /** The URL VS Code should POST to (Streamable HTTP). */
  uri: Uri;
  /** Bearer token required on every request. */
  token: string;
  dispose(): void;
}

/**
 * Start the bridge. `getClient` returns the current LanguageClient (or undefined
 * if the server is not running yet); it is resolved per request so a server
 * restart is handled transparently.
 */
export async function startMcpBridge(getClient: () => LanguageClient | undefined): Promise<McpBridge> {
  const token = randomUUID();

  const buildServer = (): Server => {
    const server = new Server(
      { name: 'omnetpp-ned-msg-ini', version: '0.2.1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const client = getClient();
      if (!client) return { tools: [] };
      const tools = await client.sendRequest<unknown[]>('omnetpp/mcp/listTools');
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const client = getClient();
      if (!client) {
        return { isError: true, content: [{ type: 'text', text: 'OMNeT++ language server is not running.' }] };
      }
      try {
        const result = await client.sendRequest('omnetpp/mcp/callTool', {
          name: req.params.name,
          arguments: req.params.arguments ?? {},
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
        };
      }
    });
    return server;
  };

  const httpServer = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no server->client SSE stream and no session to delete.
      res.writeHead(405).end();
      return;
    }
    // Fresh server + transport per request (stateless mode).
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    uri: Uri.parse(`http://127.0.0.1:${port}/mcp`),
    token,
    dispose: () => httpServer.close(),
  };
}
