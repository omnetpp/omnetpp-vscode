import * as path from 'node:path';
import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { registerViews } from './views';

let client: LanguageClient | undefined;

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

  const config = workspace.getConfiguration('omnetpp');
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'OMNeT++ NED' },
      { scheme: 'file', language: 'OMNeT++ MSG' },
      { scheme: 'file', language: 'OMNeT++ INI' },
    ],
    initializationOptions: {
      nedPath: config.get<string>('nedPath', ''),
      installDir: config.get<string>('installDir', ''),
    },
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
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
