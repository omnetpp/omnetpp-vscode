// The OMNeT++ agent plugin on disk, and the agent CLIs that install it. The plugin
// lives in a stable per-user directory (a local marketplace root), not in the
// extension directory, which changes with every update. Agents are configured only
// through their own CLIs; their private config files are never edited here.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_SKILLS,
  MARKETPLACE_NAME,
  MCP_SERVER,
  OPTIONAL_SKILLS,
  PLUGIN_DIR,
  PLUGIN_NAME,
  pluginFiles,
} from '@omnetpp/shared/agents';

export type AgentId = 'claude' | 'codex' | 'devin';

/** One CLI invocation; skipped when `unlessOk` (a check command) exits 0. */
interface Step {
  args: string[];
  unlessOk?: string[];
}

export interface AgentCli {
  id: AgentId;
  label: string;
  exe: string;
  /** Exits 0 only when the CLI can install plugins from a local directory. */
  probe: string[];
  install(root: string): Step[];
  /** What to run after the plugin directory was rewritten for a new extension version. */
  refresh(root: string): Step[];
}

const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const mcpStep = (scope: string[]): Step => ({
  args: ['mcp', 'add', ...scope, MCP_SERVER.name, '--', MCP_SERVER.command, ...MCP_SERVER.args],
  unlessOk: ['mcp', 'get', MCP_SERVER.name],
});

export const AGENT_CLIS: AgentCli[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    exe: 'claude',
    probe: ['plugin', 'marketplace', 'add', '--help'],
    install: (root) => [
      { args: ['plugin', 'install', PLUGIN_NAME, '--marketplace', root, '--scope', 'user'] },
      mcpStep(['--scope', 'user']),
    ],
    // Plugins from a local-path marketplace load in place; only the catalog is re-read.
    refresh: () => [{ args: ['plugin', 'marketplace', 'update', MARKETPLACE_NAME] }],
  },
  {
    id: 'codex',
    label: 'Codex',
    exe: 'codex',
    probe: ['plugin', 'marketplace', 'add', '--help'],
    install: (root) => [
      { args: ['plugin', 'marketplace', 'add', root] },
      { args: ['plugin', 'add', PLUGIN_ID] },
      mcpStep([]),
    ],
    // Codex installs a copy per plugin version, so the new version must be added again.
    refresh: () => [{ args: ['plugin', 'add', PLUGIN_ID] }],
  },
  {
    id: 'devin',
    label: 'Devin',
    exe: 'devin',
    probe: ['plugins', '--help'],
    install: (root) => [{ args: ['plugins', 'install', '--local', path.join(root, PLUGIN_DIR)] }, mcpStep(['--scope', 'user'])],
    // Local Devin plugins are linked to their folder, so edits are live.
    refresh: () => [],
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
      if (r.code !== 0) return { cli, available: false, reason: `this ${cli.exe} version cannot install local plugins; update it` };
      return { cli, available: true };
    }),
  );
}

/** Run the steps in order; stop at the first failure. Every command and its output goes to `log`. */
export async function runSteps(cli: AgentCli, steps: Step[], log: vscode.LogOutputChannel): Promise<boolean> {
  for (const step of steps) {
    if (step.unlessOk) {
      const check = await runCli(cli.exe, step.unlessOk);
      if (check.code === 0) {
        log.info(`${cli.exe} ${step.unlessOk.join(' ')}: already configured, left unchanged`);
        continue;
      }
    }
    log.info(`$ ${cli.exe} ${step.args.join(' ')}`);
    const r = await runCli(cli.exe, step.args);
    if (r.output.trim()) log.info(r.output.trim());
    if (r.code !== 0) {
      log.error(`${cli.exe} failed (exit code ${r.code})`);
      return false;
    }
  }
  return true;
}

/** The per-user marketplace root that holds the plugin. */
export function pluginRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'omnetpp', 'agent-plugins');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'omnetpp', 'agent-plugins');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'omnetpp', 'agent-plugins');
}

const STATE_KEY = 'omnetpp.agentPlugin';

export interface PluginState {
  version: string;
  optionalSkills: string[];
  /** Agents the plugin was installed into, for the refresh after an update. */
  agents: AgentId[];
}

export function pluginState(context: vscode.ExtensionContext): PluginState | undefined {
  return context.globalState.get<PluginState>(STATE_KEY);
}

export async function savePluginState(context: vscode.ExtensionContext, state: PluginState): Promise<void> {
  await context.globalState.update(STATE_KEY, state);
}

function extensionVersion(context: vscode.ExtensionContext): string {
  return (context.extension.packageJSON as { version: string }).version;
}

/** (Re)write the plugin directory: the generated files plus the selected skills. */
export function writePlugin(context: vscode.ExtensionContext, optionalSkills: string[]): string {
  const root = pluginRoot();
  for (const [rel, text] of Object.entries(pluginFiles(extensionVersion(context)))) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const skillsDir = path.join(root, ...PLUGIN_DIR.split('/'), 'skills');
  fs.rmSync(skillsDir, { recursive: true, force: true });
  const skills = [...DEFAULT_SKILLS, ...optionalSkills.filter((s) => OPTIONAL_SKILLS.includes(s))];
  for (const name of skills) {
    fs.cpSync(context.asAbsolutePath(path.join('dist', 'skills', name)), path.join(skillsDir, name), { recursive: true });
  }
  return root;
}

let logChannel: vscode.LogOutputChannel | undefined;
export function agentLog(): vscode.LogOutputChannel {
  logChannel ??= vscode.window.createOutputChannel('OMNeT++ Agent Setup', { log: true });
  return logChannel;
}

/** After an extension update, bring the installed plugin up to the new version. */
export async function refreshPluginIfUpdated(context: vscode.ExtensionContext): Promise<void> {
  const state = pluginState(context);
  if (!state) return;
  const version = extensionVersion(context);
  if (state.version === version) return;
  try {
    const root = writePlugin(context, state.optionalSkills);
    for (const id of state.agents) {
      const cli = AGENT_CLIS.find((c) => c.id === id);
      if (cli) await runSteps(cli, cli.refresh(root), agentLog());
    }
    await savePluginState(context, { ...state, version });
  } catch (e) {
    agentLog().error(`could not update the OMNeT++ agent plugin: ${(e as Error).message}`);
  }
}
