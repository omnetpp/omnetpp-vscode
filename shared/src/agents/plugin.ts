// The OMNeT++ agent plugins come from the public marketplace `omnetpp`
// (github.com/omnetpp/agent-plugins), which every agent installs through its own CLI or, for
// Copilot in VS Code, through VS Code's agent-plugin support. This file is the extension's
// side of that contract: the marketplace, its plugins and their dependencies, and the
// identifiers of the plugin that older extension versions generated locally.
//
// Only Claude Code resolves plugin dependencies, so the extension installs every plugin a
// pick depends on itself. Keep PLUGINS in step with plugins.json of the marketplace
// (shared/src/test/agentPlugins.test.ts checks it when AGENT_PLUGINS_DIR names a checkout).

export const MARKETPLACE_NAME = 'omnetpp';
/** Where the agent CLIs and VS Code fetch the marketplace from. */
export const MARKETPLACE_SOURCE = 'omnetpp/agent-plugins';

export interface AgentPlugin {
  name: string;
  label: string;
  dependencies: string[];
}

/** In install order: every plugin comes after the plugins it depends on. */
export const PLUGINS: AgentPlugin[] = [
  { name: 'omnetpp', label: 'OMNeT++ (model development, tools)', dependencies: [] },
  { name: 'omnetpp-dev', label: 'OMNeT++ model maintainer', dependencies: ['omnetpp'] },
  { name: 'inet', label: 'INET Framework', dependencies: ['omnetpp', 'omnetpp-dev'] },
  { name: 'simu5g', label: 'Simu5G', dependencies: ['inet'] },
];

/** The plugin every installation gets. */
export const BASE_PLUGIN = 'omnetpp';

/** The picked plugins plus the base plugin and everything they depend on, in install order. */
export function withDependencies(picks: readonly string[]): string[] {
  const byName = new Map(PLUGINS.map((p) => [p.name, p]));
  const result = new Set<string>();
  const visit = (name: string): void => {
    const p = byName.get(name);
    if (!p || result.has(name)) return;
    result.add(name);
    p.dependencies.forEach(visit);
  };
  [BASE_PLUGIN, ...picks].forEach(visit);
  return PLUGINS.map((p) => p.name).filter((n) => result.has(n));
}

export const pluginId = (name: string): string => `${name}@${MARKETPLACE_NAME}`;

/**
 * The MCP server registered with Codex, which starts plugin MCP servers in the plugin
 * directory and tells them nothing about the session's project; registered with
 * `codex mcp add` instead, it starts in the session directory, which opp_ide_mcp indexes.
 * The other agents get the server from the plugin.
 */
export const MCP_SERVER = { name: 'omnetpp', command: 'opp_ide_mcp', args: [] as string[] };

/** The plugin that extension versions up to 1.0.x generated and installed locally. */
export const LEGACY_MARKETPLACE_NAME = 'omnetpp-local';
export const LEGACY_PLUGIN_ID = `omnetpp@${LEGACY_MARKETPLACE_NAME}`;
