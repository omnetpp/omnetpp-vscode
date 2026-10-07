// Drives the agent-plugin half of "OMNeT++: Set Up AI Agents" (client/src/agentPlugin.ts)
// against the real agent CLIs, each in a throwaway config directory, so the user's own
// agent configuration is never touched: writes the plugin, runs every available CLI's
// install steps twice (the second run must succeed as well), and checks what the
// agent then reports. Agents whose CLI is missing or too old are skipped.
//
// Usage: bun scripts/agent-setup-smoke.mjs   (after `bun run dev:build`, for dist/skills)
import { mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'agent-setup-'));
process.env.XDG_DATA_HOME = join(tmp, 'data');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
process.env.CODEX_HOME = join(tmp, 'codex');
for (const d of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) spawnSync('mkdir', ['-p', d]);

const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`), show() {} };
mock.module('vscode', () => ({ window: { createOutputChannel: () => log } }));
const { AGENT_CLIS, probeAgents, runSteps, writePlugin, pluginRoot } = await import('../client/src/agentPlugin.ts');

const context = {
  extension: { packageJSON: { version: '9.9.9' } },
  asAbsolutePath: (p) => join(root, p),
};

let failed = false;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${cond || !detail ? '' : `\n${detail}`}`);
  if (!cond) failed = true;
}

try {
  if (process.platform !== 'win32') {
    check('plugin root follows XDG_DATA_HOME', pluginRoot() === join(tmp, 'data', 'omnetpp', 'agent-plugins'));
  }
  const pluginDir = writePlugin(context, ['omnetpp-model-refactoring']);
  const skills = join(pluginDir, 'plugins', 'omnetpp', 'skills');
  check('plugin has the default and the chosen optional skills',
    existsSync(join(skills, 'omnetpp-tooling', 'SKILL.md')) && existsSync(join(skills, 'omnetpp-model-refactoring', 'SKILL.md')) &&
      !existsSync(join(skills, 'omnetpp-fingerprint-testing')));
  writePlugin(context, []);
  check('a rewrite drops a deselected optional skill', !existsSync(join(skills, 'omnetpp-model-refactoring')));

  for (const a of await probeAgents()) {
    if (!a.available) {
      console.log(`SKIP ${a.cli.label}: ${a.reason}`);
      continue;
    }
    for (const run of ['first', 'second']) {
      lines.length = 0;
      const ok = await runSteps(a.cli, a.cli.install(pluginDir), log);
      check(`${a.cli.label}: ${run} install run`, ok, lines.join('\n'));
    }
    const run = (args) => spawnSync(a.cli.exe, args, { encoding: 'utf8', cwd: tmp });
    const mcp = run(['mcp', 'get', 'omnetpp']);
    check(`${a.cli.label}: MCP server registered`, mcp.status === 0 && /opp_ide_mcp/.test(mcp.stdout + mcp.stderr), mcp.stdout + mcp.stderr);
    if (a.cli.id === 'claude') {
      const d = run(['plugin', 'details', 'omnetpp@omnetpp-local']);
      check('Claude Code: plugin has skills, the hook and the LSP server',
        /Skills \(5\)/.test(d.stdout) && /Hooks \(1\)/.test(d.stdout) && /LSP servers \(1\)/.test(d.stdout) && /MCP servers \(0\)/.test(d.stdout), d.stdout + d.stderr);
    }
    if (a.cli.id === 'codex') {
      const l = run(['plugin', 'list']);
      check('Codex: plugin installed', /omnetpp@omnetpp-local\s+installed/.test(l.stdout), l.stdout + l.stderr);
    }
    lines.length = 0;
    check(`${a.cli.label}: refresh steps`, await runSteps(a.cli, a.cli.refresh(pluginDir), log), lines.join('\n'));
  }
  console.log(failed ? 'AGENT SETUP SMOKE FAILED' : 'AGENT SETUP SMOKE PASSED');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
