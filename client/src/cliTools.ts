// "OMNeT++: Install / Uninstall Command-Line Tools": puts opp_lint, opp_docgen,
// opp_ide_mcp and opp_lsp on the user's PATH as small shim scripts that run the
// bundles shipped in this extension's dist/ with VS Code's own runtime
// (ELECTRON_RUN_AS_NODE=1), so no Node.js install is needed. The extension directory and
// the runtime path change on updates, and every editor with the extension shares the
// same shims, so on activation each editor repairs the shims that no longer work.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isBrokenShim, isShim, needsRepair, shimContent, shimFileName } from '@omnetpp/shared/cli-shims';

const TOOLS = ['opp_lint', 'opp_docgen', 'opp_ide_mcp', 'opp_lsp'];
const STATE_KEY = 'omnetpp.cliTools';
const isWindows = process.platform === 'win32';

interface InstalledState {
  binDir: string;
  runtime: string;
  distDir: string;
}

function defaultBinDir(): string {
  return isWindows
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'omnetpp', 'bin')
    : path.join(os.homedir(), '.local', 'bin');
}

function shimPath(binDir: string, tool: string): string {
  return path.join(binDir, shimFileName(tool, process.platform));
}

function readShim(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function isOurs(file: string): boolean {
  const content = readShim(file);
  return content !== undefined && isShim(content);
}

function isWorking(file: string): boolean {
  const content = readShim(file);
  return content !== undefined && !isBrokenShim(content, fs.existsSync);
}

function writeShims(state: InstalledState, tools: string[]): void {
  fs.mkdirSync(state.binDir, { recursive: true });
  for (const tool of tools) {
    const file = shimPath(state.binDir, tool);
    fs.writeFileSync(file, shimContent(tool, state.runtime, path.join(state.distDir, `${tool}.js`), process.platform));
    if (!isWindows) fs.chmodSync(file, 0o755);
  }
}

function isOnPath(dir: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return isWindows ? r.toLowerCase() : r;
  };
  const target = norm(dir);
  return (process.env.PATH ?? '').split(path.delimiter).some((p) => p && norm(p) === target);
}

function currentState(context: vscode.ExtensionContext, binDir: string): InstalledState {
  return { binDir, runtime: process.execPath, distDir: context.asAbsolutePath('dist') };
}

/** Install the shims unless all of them exist and work. Returns the bin directory and whether
 *  it is on PATH, or undefined when the user declined or the install failed. */
export async function ensureCliTools(context: vscode.ExtensionContext): Promise<{ binDir: string; onPath: boolean } | undefined> {
  const binDir = context.globalState.get<InstalledState>(STATE_KEY)?.binDir ?? defaultBinDir();
  if (TOOLS.every((t) => isWorking(shimPath(binDir, t)))) return { binDir, onPath: isOnPath(binDir) };
  return (await install(context)) ? { binDir: defaultBinDir(), onPath: isOnPath(defaultBinDir()) } : undefined;
}

async function install(context: vscode.ExtensionContext): Promise<boolean> {
  const binDir = defaultBinDir();
  const foreign = TOOLS.map((t) => shimPath(binDir, t)).filter((f) => fs.existsSync(f) && !isOurs(f));
  if (foreign.length) {
    const answer = await vscode.window.showWarningMessage(
      `These files already exist and were not created by this extension:\n${foreign.join('\n')}`,
      { modal: true, detail: 'They may come from the @omnetpp/opp-tools npm package. Overwrite them?' },
      'Overwrite',
    );
    if (answer !== 'Overwrite') return false;
  }
  const state = currentState(context, binDir);
  try {
    writeShims(state, TOOLS);
  } catch (e) {
    void vscode.window.showErrorMessage(`OMNeT++: could not install the command-line tools into ${binDir}: ${(e as Error).message}`);
    return false;
  }
  await context.globalState.update(STATE_KEY, state);
  const installed = `Installed ${TOOLS.join(', ')} into ${binDir}.`;
  if (isOnPath(binDir)) {
    void vscode.window.showInformationMessage(`OMNeT++: ${installed}`);
    return true;
  }
  const copy = 'Copy Folder Path';
  void vscode.window
    .showWarningMessage(
      `OMNeT++: ${installed} This folder is not on your PATH yet — add it to use the tools from a shell (open a new terminal afterwards).`,
      copy,
    )
    .then((answer) => (answer === copy ? vscode.env.clipboard.writeText(binDir) : undefined));
  return true;
}

async function uninstall(context: vscode.ExtensionContext): Promise<void> {
  const state = context.globalState.get<InstalledState>(STATE_KEY);
  const binDir = state?.binDir ?? defaultBinDir();
  const removed: string[] = [];
  for (const tool of TOOLS) {
    const file = shimPath(binDir, tool);
    if (!isOurs(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(tool);
  }
  await context.globalState.update(STATE_KEY, undefined);
  void vscode.window.showInformationMessage(
    removed.length
      ? `OMNeT++: removed ${removed.join(', ')} from ${binDir}.`
      : `OMNeT++: no command-line tools installed by this extension were found in ${binDir}.`,
  );
}

/** Points the shims that need it (see needsRepair) at this editor. Shims the user deleted
 *  or replaced are not recreated. */
function repairShims(context: vscode.ExtensionContext): void {
  // A development or test host would point the user's real shims at a workspace dist/.
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  const state = context.globalState.get<InstalledState>(STATE_KEY);
  const binDir = state?.binDir ?? defaultBinDir();
  const now = currentState(context, binDir);
  const targets = (s: InstalledState, tool: string) => ({ script: path.join(s.distDir, `${tool}.js`), runtime: s.runtime });
  const repair = TOOLS.filter((tool) => {
    const content = readShim(shimPath(binDir, tool));
    return content !== undefined && needsRepair(content, fs.existsSync, targets(now, tool), state && targets(state, tool));
  });
  const moved = !!state && (state.runtime !== now.runtime || state.distDir !== now.distDir);
  if (!repair.length) {
    if (state && !TOOLS.some((t) => isOurs(shimPath(binDir, t)))) void context.globalState.update(STATE_KEY, undefined);
    else if (moved) void context.globalState.update(STATE_KEY, now);
    return;
  }
  try {
    writeShims(now, repair);
    void context.globalState.update(STATE_KEY, now);
  } catch {
    // Leave the stale shims; they print a hint to run the install command again.
  }
}

export function registerCliToolsCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.installCliTools', () => install(context)),
    vscode.commands.registerCommand('omnetpp.uninstallCliTools', () => uninstall(context)),
  );
  repairShims(context);
}
