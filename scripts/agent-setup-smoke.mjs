// Drives the agent half of "OMNeT++: Set Up AI Agents" (client/src/agentPlugin.ts)
// against the real agent CLIs, each in a throwaway config directory (and a throwaway
// HOME), so the user's own agent configuration is never touched. For every available CLI:
// sets up an old locally generated `omnetpp-local` plugin (and, for Claude, the MCP server
// the old extension registered), runs the startup migration to the marketplace plugins,
// checks what the agent then reports, runs the install steps again (they must succeed a
// second time), and runs the refresh steps. Agents whose CLI is missing or too old are
// skipped. Needs network access to fetch the marketplace.
//
// Usage: OMNETPP_AGENT_MARKETPLACE=omnetpp/agent-plugins#agent-plugins bun scripts/agent-setup-smoke.mjs
// (without the variable, the marketplace's default branch is used)
import { mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'agent-setup-'));
const realHome = process.env.HOME;
process.env.XDG_DATA_HOME = join(tmp, 'data');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
process.env.CODEX_HOME = join(tmp, 'codex');
process.env.HOME = join(tmp, 'home');
// git keeps reading the user's git configuration through this.
process.env.GIT_CONFIG_GLOBAL ??= join(realHome, '.gitconfig');
for (const d of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.HOME]) mkdirSync(d, { recursive: true });

const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`), show() {} };
mock.module('vscode', () => ({
  window: { createOutputChannel: () => log, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
}));
const { probeAgents, runSteps, refreshPluginIfUpdated, legacyPluginRoot, marketplaceSource, pluginState } = await import(
  '../client/src/agentPlugin.ts'
);
const { PLUGINS, withDependencies, LEGACY_PLUGIN_ID } = await import('../shared/src/agents/plugin.ts');

let failed = false;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${cond || !detail ? '' : `\n${detail}`}`);
  if (!cond) failed = true;
}

// A minimal stand-in for the plugin that extension versions up to 1.0.x generated.
function writeLegacyPlugin() {
  const root = legacyPluginRoot();
  const files = {
    '.claude-plugin/marketplace.json': { name: 'omnetpp-local', owner: { name: 'test' }, plugins: [{ name: 'omnetpp', source: './plugins/omnetpp' }] },
    '.agents/plugins/marketplace.json': { name: 'omnetpp-local', plugins: [{ name: 'omnetpp', source: { source: 'local', path: './plugins/omnetpp' } }] },
    'plugins/omnetpp/.claude-plugin/plugin.json': { name: 'omnetpp', version: '1.0.0', description: 'legacy' },
    'plugins/omnetpp/plugin.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'omnetpp', version: '1.0.0' },
  };
  for (const [rel, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(value));
  }
  return root;
}

function memento(initial) {
  const values = new Map(Object.entries(initial));
  return { get: (k) => values.get(k), update: async (k, v) => values.set(k, v) };
}

try {
  const source = marketplaceSource();
  console.log(`marketplace: ${source.location}${source.ref ? `#${source.ref}` : ''}`);
  const plugins = withDependencies(PLUGINS.map((p) => p.name));
  for (const a of await probeAgents()) {
    if (!a.available) {
      console.log(`SKIP ${a.cli.label}: ${a.reason}`);
      continue;
    }
    const run = (args) => spawnSync(a.cli.exe, args, { encoding: 'utf8', cwd: tmp, input: '' });
    // Devin manages plugins only when logged in, which the throwaway HOME is not.
    if (a.cli.id === 'devin' && /logged in/i.test(run(['plugins', 'list']).stdout + run(['plugins', 'list']).stderr)) {
      console.log('SKIP Devin: needs a login to manage plugins, and this run uses a throwaway HOME');
      continue;
    }
    const legacyRoot = writeLegacyPlugin();
    if (a.cli.id === 'claude') {
      run(['plugin', 'marketplace', 'add', legacyRoot]);
      run(['plugin', 'install', 'omnetpp@omnetpp-local', '--scope', 'user']);
      run(['mcp', 'add', '--scope', 'user', 'omnetpp', '--', 'opp_ide_mcp']);
    } else if (a.cli.id === 'codex') {
      run(['plugin', 'marketplace', 'add', legacyRoot]);
      run(['plugin', 'add', 'omnetpp@omnetpp-local']);
    }

    lines.length = 0;
    const legacyState = { version: '1.0.1', optionalSkills: ['omnetpp-model-refactoring'], agents: [a.cli.id] };
    const window = () => ({
      extension: { packageJSON: { version: '9.9.9' } },
      globalStorageUri: { fsPath: join(tmp, 'globalStorage', a.cli.id) },
      globalState: memento({ 'omnetpp.agentPlugin': legacyState }),
    });
    const context = window();
    await refreshPluginIfUpdated(context, async () => {});
    const state = pluginState(context);
    check(`${a.cli.label}: migration keeps the agent and maps the optional skills to omnetpp-dev`,
      state?.version === '9.9.9' && state.agents.includes(a.cli.id) && state.plugins.join() === 'omnetpp,omnetpp-dev', JSON.stringify(state));
    check(`${a.cli.label}: migration reported no failure`, !lines.some((l) => l.startsWith('ERROR')), lines.join('\n'));
    check(`${a.cli.label}: the old plugin folder is gone`, !existsSync(legacyRoot));
    lines.length = 0;
    const other = window();
    await refreshPluginIfUpdated(other, async () => {});
    check(`${a.cli.label}: a second window that starts meanwhile leaves the update to the first`,
      other.globalState.get('omnetpp.agentPlugin') === legacyState && lines.length === 0, lines.join('\n'));

    if (a.cli.id === 'claude') {
      const l = run(['plugin', 'list']).stdout;
      check('Claude Code: the marketplace plugins are installed and the old one is gone',
        /omnetpp@omnetpp\b/.test(l) && /omnetpp-dev@omnetpp/.test(l) && !l.includes(LEGACY_PLUGIN_ID), l);
      const d = run(['plugin', 'details', 'omnetpp@omnetpp']).stdout;
      check('Claude Code: omnetpp brings skills, the hook, the MCP server and the LSP server',
        /Skills \(\d+\)/.test(d) && /Hooks \(1\)/.test(d) && /MCP servers \(1\)/.test(d) && /LSP servers \(1\)/.test(d), d);
      const m = run(['mcp', 'get', 'omnetpp']);
      check('Claude Code: the old user-level MCP registration is removed', m.status !== 0, m.stdout + m.stderr);
    }
    if (a.cli.id === 'codex') {
      const l = run(['plugin', 'list']).stdout;
      check('Codex: the marketplace plugins are installed and the old one is gone',
        /omnetpp@omnetpp\s+installed/.test(l) && /omnetpp-dev@omnetpp\s+installed/.test(l) && !/omnetpp@omnetpp-local\s+installed/.test(l), l);
      const m = run(['mcp', 'get', 'omnetpp']);
      check('Codex: the omnetpp MCP server is registered', m.status === 0 && /opp_ide_mcp/.test(m.stdout + m.stderr), m.stdout + m.stderr);
    }
    if (a.cli.id === 'devin') {
      const l = run(['plugins', 'list']).stdout;
      check('Devin: the plugins are installed', /omnetpp/.test(l) && /omnetpp-dev/.test(l), l);
    }

    lines.length = 0;
    check(`${a.cli.label}: a second install run succeeds`, await runSteps(a.cli, a.cli.install(plugins, source), log), lines.join('\n'));
    lines.length = 0;
    check(`${a.cli.label}: refresh steps`, await runSteps(a.cli, a.cli.refresh(plugins), log), lines.join('\n'));
  }
  console.log(failed ? 'AGENT SETUP SMOKE FAILED' : 'AGENT SETUP SMOKE PASSED');
} finally {
  process.env.HOME = realHome;
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
