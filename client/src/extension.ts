import * as path from 'node:path';
import {
  ExtensionContext,
  workspace,
  window,
  extensions,
  RelativePattern,
  lm,
  McpHttpServerDefinition,
  Disposable,
} from 'vscode';
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

/** The slice of VS Code's built-in Git extension API we use, so we can react to
 *  HEAD changes without a hard dependency on its `git.d.ts` types. */
interface GitRepository {
  readonly state: { onDidChange(listener: () => void): Disposable };
}
interface GitAPI {
  readonly repositories: GitRepository[];
  onDidOpenRepository(listener: (repo: GitRepository) => void): Disposable;
}
interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

/** The `omnetpp.*` settings the server consumes; read on activation and on change. */
function readSettings() {
  const config = workspace.getConfiguration('omnetpp');
  return {
    nedPath: config.get<string>('nedPath', ''),
    installDir: config.get<string>('installDir', ''),
    diagnostics: {
      scope: config.get<string>('diagnostics.scope', 'workspace'),
    },
    codeLens: {
      iniParams: config.get<boolean>('codeLens.iniParams', true),
    },
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
        workspace.createFileSystemWatcher('**/*.ini'),
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
  registerRevalidationTriggers(context);

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
 * Ask the server to reconcile its index against disk when a background process may
 * have changed files without reliable watch events — chiefly git operations
 * (checkout/reset/stash) and returning focus to the window after external edits.
 * All triggers are coalesced through one debounce.
 */
function registerRevalidationTriggers(context: ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;
  const poke = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void client?.sendNotification('omnetpp/revalidate');
    }, 250);
  };

  // Window focus regained: a `git checkout` run in a terminal or another editor may
  // have rewritten files while VS Code was unfocused (and dropped watch events).
  context.subscriptions.push(
    window.onDidChangeWindowState((e) => {
      if (e.focused) poke();
    }),
  );

  // Git HEAD changes (checkout/reset/stash) — the most reliable bulk-change signal.
  const gitExports = extensions.getExtension<GitExtensionExports>('vscode.git')?.exports;
  const api = gitExports?.getAPI(1);
  if (api) {
    const hook = (repo: GitRepository): void => {
      context.subscriptions.push(repo.state.onDidChange(poke));
    };
    api.repositories.forEach(hook);
    context.subscriptions.push(api.onDidOpenRepository(hook));
  } else {
    // Fallback when the Git extension is unavailable: watch `.git/HEAD` per folder.
    // (A bare `**` glob never matches dotfolders, so anchor it with a RelativePattern.)
    for (const folder of workspace.workspaceFolders ?? []) {
      const w = workspace.createFileSystemWatcher(new RelativePattern(folder, '.git/HEAD'));
      context.subscriptions.push(w, w.onDidChange(poke), w.onDidCreate(poke));
    }
  }
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
