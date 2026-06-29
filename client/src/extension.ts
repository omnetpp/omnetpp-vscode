import * as path from 'node:path';
import { ExtensionContext, workspace, lm, McpHttpServerDefinition } from 'vscode';
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { registerViews } from './views';
import { startMcpBridge } from './mcpBridge';

let client: LanguageClient | undefined;

/** The `omnetpp.*` settings the server consumes; read on activation and on change. */
function readSettings() {
  const config = workspace.getConfiguration('omnetpp');
  return {
    nedPath: config.get<string>('nedPath', ''),
    installDir: config.get<string>('installDir', ''),
  };
}

export function activate(context: ExtensionContext): void {
  // The bundled server lives next to the bundled client in dist/.
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'OMNeT++ NED' },
      { scheme: 'file', language: 'OMNeT++ MSG' },
      { scheme: 'file', language: 'OMNeT++ INI' },
    ],
    initializationOptions: readSettings(),
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher('**/*.ned'),
        workspace.createFileSystemWatcher('**/*.msg'),
        workspace.createFileSystemWatcher('**/{.nedfolders,.nedexclusions,package.ned}'),
      ],
    },
  };

  client = new LanguageClient(
    'omnetpp',
    'OMNeT++ Language Server',
    serverOptions,
    clientOptions
  );

  void client.start();
  registerViews(context, client);

  // Push setting changes to the server so they apply without a window reload.
  // (The LanguageClient handles `omnetpp.trace.server` live on its own.)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('omnetpp')) return;
      void client?.sendNotification(DidChangeConfigurationNotification.type, {
        settings: { omnetpp: readSettings() },
      });
    }),
  );

  registerMcpProvider(context);
}

/**
 * Expose the project's live semantic model as an MCP server (NED/MSG/INI queries
 * + refactorings), backed by the running language server's live index. Guarded so
 * the extension still works on editors without the MCP API.
 */
function registerMcpProvider(context: ExtensionContext): void {
  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function') return;
  void startMcpBridge(() => client).then((bridge) => {
    context.subscriptions.push({ dispose: () => bridge.dispose() });
    context.subscriptions.push(
      lm.registerMcpServerDefinitionProvider('omnetpp.liveModel', {
        provideMcpServerDefinitions: () => [
          new McpHttpServerDefinition('OMNeT++ NED/MSG/INI (live)', bridge.uri, {
            Authorization: `Bearer ${bridge.token}`,
          }),
        ],
      }),
    );
  });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
