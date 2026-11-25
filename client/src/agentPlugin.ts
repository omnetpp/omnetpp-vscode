// The OMNeT++ agent plugins, installed from the public marketplace `omnetpp`
// (github.com/omnetpp/agent-plugins) into the agent CLIs. Agents are configured only through
// their own CLIs; their private config files are never edited here.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LEGACY_MARKETPLACE_NAME,
  LEGACY_PLUGIN_ID,
  MARKETPLACE_NAME,
  MARKETPLACE_SOURCE,
  MCP_SERVER,
  pluginId,
  withDependencies,
} from '@omnetpp/shared/agents';
import { claimOnce } from '@omnetpp/shared/node';
import { cliToolsInstalled } from './cliTools';

export type AgentId = 'claude' | 'codex' | 'devin';

/** One CLI invocation. */
interface Step {
  args: string[];
  /** Skip the step when this check command exits 0. */
  unlessOk?: string[];
  /** Run the step only when this check command exits 0 and its output matches. */
  onlyIf?: { args: string[]; match: RegExp };
  /** A failure is logged but does not stop the remaining steps. */
  optional?: boolean;
}

/** Where to fetch the marketplace from: a GitHub `owner/repo`, a git URL or a local path, plus a ref. */
export interface MarketplaceSource {
  location: string;
  ref?: string;
  local: boolean;
}

/**
 * The marketplace source. OMNETPP_AGENT_MARKETPLACE overrides it for testing, e.g.
 * `omnetpp/agent-plugins#agent-plugins` or the path of a local checkout.
 */
export function marketplaceSource(): MarketplaceSource {
  const value = process.env.OMNETPP_AGENT_MARKETPLACE?.trim() || MARKETPLACE_SOURCE;
  const local = path.isAbsolute(value) || value.startsWith('.') || value.startsWith('~');
  if (local) return { location: value.replace(/^~(?=$|[\\/])/, os.homedir()), local: true };
  const hash = value.lastIndexOf('#');
  return hash < 0 ? { location: value, local: false } : { location: value.slice(0, hash), ref: value.slice(hash + 1), local: false };
}

const withRef = (s: MarketplaceSource): string => (s.ref ? `${s.location}#${s.ref}` : s.location);

export interface AgentCli {
  id: AgentId;
  label: string;
  exe: string;
  /** Exits 0 only when the CLI can install plugins from a marketplace. */
  probe: string[];
  install(plugins: string[], source: MarketplaceSource): Step[];
  /** What to run after an extension update, to bring the installed plugins up to date. */
  refresh(plugins: string[]): Step[];
  /** Removes the plugin that extension versions up to 1.0.x generated locally. */
  removeLegacy(): Step[];
}

// The extension registered `<agent> mcp add omnetpp -- opp_ide_mcp` before the plugins
// brought the MCP server themselves. Only that exact registration is removed; a server
// the user set up differently is theirs.
const legacyMcpCleanup = (removeArgs: string[]): Step => ({
  args: removeArgs,
  onlyIf: { args: ['mcp', 'get', MCP_SERVER.name], match: new RegExp(`^\\s*Command:\\s*${MCP_SERVER.command}\\s*$`, 'm') },
  optional: true,
});

export const AGENT_CLIS: AgentCli[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    exe: 'claude',
    probe: ['plugin', 'marketplace', 'add', '--help'],
    // Both commands succeed when the marketplace or plugin is already there.
    install: (plugins, source) => [
      { args: ['plugin', 'marketplace', 'add', withRef(source)] },
      ...plugins.map((p) => ({ args: ['plugin', 'install', pluginId(p), '--scope', 'user'] })),
      legacyMcpCleanup(['mcp', 'remove', MCP_SERVER.name, '--scope', 'user']),
    ],
    // Claude updates an installed plugin only when the marketplace has a new version of it.
    refresh: (plugins) => [
      { args: ['plugin', 'marketplace', 'update', MARKETPLACE_NAME] },
      ...plugins.map((p) => ({ args: ['plugin', 'update', pluginId(p)], optional: true })),
    ],
    removeLegacy: () => [
      { args: ['plugin', 'uninstall', LEGACY_PLUGIN_ID, '--scope', 'user'], optional: true },
      { args: ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE_NAME], optional: true },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    exe: 'codex',
    probe: ['plugin', 'marketplace', 'add', '--help'],
    // Codex starts plugin MCP servers in the plugin directory, so the server is
    // registered here and starts in the session directory, which opp_ide_mcp indexes.
    install: (plugins, source) => [
      { args: ['plugin', 'marketplace', 'add', source.location, ...(source.ref ? ['--ref', source.ref] : [])] },
      ...plugins.map((p) => ({ args: ['plugin', 'add', pluginId(p)] })),
      {
        args: ['mcp', 'add', MCP_SERVER.name, '--', MCP_SERVER.command, ...MCP_SERVER.args],
        unlessOk: ['mcp', 'get', MCP_SERVER.name],
      },
    ],
    // `upgrade` refreshes a git marketplace and reinstalls its plugins when it has moved on;
    // a local marketplace (the test override) has nothing to upgrade, and `plugin add`
    // reinstalls a plugin whose version changed.
    refresh: (plugins) => [
      { args: ['plugin', 'marketplace', 'upgrade', MARKETPLACE_NAME], optional: true },
      ...plugins.map((p) => ({ args: ['plugin', 'add', pluginId(p)] })),
    ],
    removeLegacy: () => [
      { args: ['plugin', 'remove', LEGACY_PLUGIN_ID], optional: true },
      { args: ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE_NAME], optional: true },
    ],
  },
  {
    id: 'devin',
    label: 'Devin',
    exe: 'devin',
    probe: ['plugins', '--help'],
    // Devin installs a plugin from a repository path and has no marketplace of its own; it
    // takes no ref, so an override with a ref falls back to the default branch. -y answers
    // its trust prompt, which would otherwise abort the install: the user confirmed the
    // setup in the extension's own dialog. Devin loads the plugin's MCP server itself.
    install: (plugins, source) => [
      ...plugins.map((p) => ({
        args: [
          'plugins',
          'install',
          '-y',
          '--local',
          source.local ? path.join(source.location, 'plugins', p) : `${source.location}#plugins/${p}`,
        ],
      })),
      legacyMcpCleanup(['mcp', 'remove', MCP_SERVER.name]),
    ],
    refresh: (plugins) => plugins.map((p) => ({ args: ['plugins', 'update', p], optional: true })),
    // Older extension versions installed Devin's plugin without answering the trust
    // prompt, which aborts the install, so there is nothing to remove.
    removeLegacy: () => [],
  },
];

export interface RunResult {
  code: number | null;
  output: string;
  /** The executable was not found. */
  missing: boolean;
}

/** Run an agent CLI in the home directory, so no project-level agent config interferes. */
export function runCli(exe: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    // On Windows the agent CLIs are usually .cmd shims, which only a shell can start.
    const child = isWindows
      ? spawn([exe, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' '), { shell: true, cwd: os.homedir(), windowsHide: true })
      : spawn(exe, args, { cwd: os.homedir() });
    let output = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    // A CLI that prompts gets end-of-input instead of waiting until the timeout.
    child.stdin?.end();
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, output: e.message, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // cmd.exe reports a missing command as exit code 9009.
      resolve({ code, output, missing: isWindows && code === 9009 });
    });
  });
}

export interface AgentAvailability {
  cli: AgentCli;
  available: boolean;
  /** Why the agent cannot be set up, when it is not available. */
  reason?: string;
}

export async function probeAgents(): Promise<AgentAvailability[]> {
  return Promise.all(
    AGENT_CLIS.map(async (cli) => {
      const r = await runCli(cli.exe, cli.probe, 30_000);
      if (r.missing) return { cli, available: false, reason: `${cli.exe} not found on PATH` };
      if (r.code !== 0) return { cli, available: false, reason: `this ${cli.exe} version cannot install plugins; update it` };
      return { cli, available: true };
    }),
  );
}

/** Run the steps in order; stop at the first failure of a required step. Every command and its output goes to `log`. */
export async function runSteps(cli: AgentCli, steps: Step[], log: vscode.LogOutputChannel): Promise<boolean> {
  for (const step of steps) {
    if (step.unlessOk) {
      const check = await runCli(cli.exe, step.unlessOk);
      if (check.code === 0) {
        log.info(`${cli.exe} ${step.unlessOk.join(' ')}: already configured, left unchanged`);
        continue;
      }
    }
    if (step.onlyIf) {
      const check = await runCli(cli.exe, step.onlyIf.args);
      if (check.code !== 0 || !step.onlyIf.match.test(check.output)) continue;
    }
    log.info(`$ ${cli.exe} ${step.args.join(' ')}`);
    const r = await runCli(cli.exe, step.args);
    if (r.output.trim()) log.info(r.output.trim());
    if (r.code !== 0) {
      if (step.optional) {
        log.info(`${cli.exe} exited with ${r.code}; not needed, continuing`);
        continue;
      }
      log.error(`${cli.exe} failed (exit code ${r.code})`);
      return false;
    }
  }
  return true;
}

/** The folder where extension versions up to 1.0.x wrote the generated plugin. */
export function legacyPluginRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'omnetpp', 'agent-plugins');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'omnetpp', 'agent-plugins');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'omnetpp', 'agent-plugins');
}

const STATE_KEY = 'omnetpp.agentPlugin';

export interface PluginState {
  version: string;
  /** The installed plugins, with their dependencies, in install order. */
  plugins: string[];
  /** Agent CLIs the plugins were installed into, for the refresh after an update. */
  agents: AgentId[];
  /** Copilot in VS Code was set up. */
  copilot?: boolean;
  /** The one-time notice about Copilot's skills was shown, or is not needed (a new install). */
  copilotNoticeDone?: boolean;
}

/** The state written by extension versions up to 1.0.x, which generated the plugin locally. */
interface LegacyPluginState {
  version: string;
  optionalSkills: string[];
  agents: AgentId[];
}

function isLegacy(s: PluginState | LegacyPluginState): s is LegacyPluginState {
  return !('plugins' in s);
}

export function pluginState(context: vscode.ExtensionContext): PluginState | undefined {
  const s = context.globalState.get<PluginState | LegacyPluginState>(STATE_KEY);
  if (!s || !isLegacy(s)) return s;
  // The optional skills were the maintainer skills, which are now the omnetpp-dev plugin.
  return { version: s.version, plugins: withDependencies(s.optionalSkills.length ? ['omnetpp-dev'] : []), agents: s.agents };
}

function hasLegacyState(context: vscode.ExtensionContext): boolean {
  const s = context.globalState.get<PluginState | LegacyPluginState>(STATE_KEY);
  return !!s && isLegacy(s);
}

/** Changes the saved state. The current state is read here, not passed in, because the
 *  startup update and the setup command run concurrently and each would overwrite the
 *  other's changes with the state it read before its slow installs. */
export async function updatePluginState(
  context: vscode.ExtensionContext,
  change: (state: PluginState | undefined) => PluginState,
): Promise<void> {
  await context.globalState.update(STATE_KEY, change(pluginState(context)));
}

export function extensionVersion(context: vscode.ExtensionContext): string {
  return (context.extension.packageJSON as { version: string }).version;
}

let logChannel: vscode.LogOutputChannel | undefined;
export function agentLog(): vscode.LogOutputChannel {
  logChannel ??= vscode.window.createOutputChannel('OMNeT++ Agent Setup', { log: true });
  return logChannel;
}

/** Replace the locally generated plugin of older extension versions with the marketplace plugins. */
async function moveOffLegacyPlugin(context: vscode.ExtensionContext, state: PluginState): Promise<void> {
  const log = agentLog();
  const moved: string[] = [];
  const failed: string[] = [];
  for (const id of state.agents) {
    const cli = AGENT_CLIS.find((c) => c.id === id);
    if (!cli) continue;
    const ok = (await runSteps(cli, cli.removeLegacy(), log)) && (await runSteps(cli, cli.install(state.plugins, marketplaceSource()), log));
    (ok ? moved : failed).push(cli.label);
  }
  try {
    fs.rmSync(legacyPluginRoot(), { recursive: true, force: true });
  } catch (e) {
    log.warn(`could not delete ${legacyPluginRoot()}: ${(e as Error).message}`);
  }
  await updatePluginState(context, (s) => ({ ...(s ?? state), version: extensionVersion(context) }));
  if (!moved.length && !failed.length) return;
  const message =
    `OMNeT++: the AI agent plugins now come from the "${MARKETPLACE_NAME}" marketplace (github.com/${MARKETPLACE_SOURCE}).` +
    (moved.length ? ` Moved ${moved.join(', ')} to it.` : '') +
    (failed.length ? ` Failed for ${failed.join(', ')}; run "OMNeT++: Set Up AI Agents…" again.` : '');
  const show = 'Show Details';
  // Not awaited: the setup command waits for this update, and the notice stays until dismissed.
  void (failed.length ? vscode.window.showWarningMessage(message, show) : vscode.window.showInformationMessage(message, show)).then(
    (answer) => answer === show && log.show(true),
  );
}

let pendingUpdate: Promise<void> = Promise.resolve();

/** Resolves once the startup update of the installed plugins is done. */
export function pluginUpdateDone(): Promise<void> {
  return pendingUpdate;
}

/** Moves older setups off the locally generated plugin, and brings the installed plugins up
 *  to date after an extension update. */
async function updatePlugins(context: vscode.ExtensionContext): Promise<void> {
  const state = pluginState(context);
  const version = extensionVersion(context);
  const legacy = hasLegacyState(context);
  if (!state || (!legacy && state.version === version)) return;
  // All windows start together after an extension update; one of them does the update.
  if (!claimOnce(context.globalStorageUri.fsPath, `agent-plugins-update-${version}`)) return;
  if (legacy) {
    await moveOffLegacyPlugin(context, state);
    return;
  }
  for (const id of state.agents) {
    const cli = AGENT_CLIS.find((c) => c.id === id);
    if (cli) await runSteps(cli, cli.refresh(state.plugins), agentLog());
  }
  await updatePluginState(context, (s) => ({ ...(s ?? state), version }));
}

/** On startup: update the installed plugins, then point Copilot users of 1.0.x to the setup once. */
export async function refreshPluginIfUpdated(
  context: vscode.ExtensionContext,
  copilotNotice: (state: PluginState | undefined, upgradedFromLegacy: boolean) => Promise<void>,
): Promise<void> {
  // Read before the update, which rewrites a 1.0.x state in the current shape.
  const upgradedFromLegacy = hasLegacyState(context) || cliToolsInstalled(context);
  pendingUpdate = updatePlugins(context).catch((e) =>
    agentLog().error(`could not update the OMNeT++ agent plugins: ${(e as Error).message}`),
  );
  await pendingUpdate;
  // Not part of pendingUpdate: the notice can run the setup command, which waits for it.
  try {
    await copilotNotice(pluginState(context), upgradedFromLegacy);
  } catch (e) {
    agentLog().error(`could not show the Copilot notice: ${(e as Error).message}`);
  }
}
