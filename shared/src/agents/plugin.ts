// The OMNeT++ agent plugin: one directory that Claude Code, Codex and Devin each
// install from a local marketplace. Each agent reads its own manifest and config
// files from it (Claude: .claude-plugin/, hooks/hooks.json, .lsp.json; Codex: the
// Agent Plugins root plugin.json, hooks/hooks.json; Devin: .claude-plugin/plugin.json,
// the root hooks.json), and all of them read skills/. The tools are started by
// their bare command names, which the extension's command-line tool shims (or the
// npm package) put on PATH.
//
// The MCP server is not part of the plugin: Codex starts plugin MCP servers in the
// plugin directory and tells them nothing about the session's project, so
// opp_ide_mcp would index the wrong directory. Registered with each agent's own
// `mcp add` at user scope instead (MCP_SERVER), it starts in the session directory.

export const PLUGIN_NAME = 'omnetpp';
export const MARKETPLACE_NAME = 'omnetpp-local';
/** The plugin's directory, relative to the marketplace root. */
export const PLUGIN_DIR = 'plugins/omnetpp';

/** Skills every installation gets; Copilot gets the same set through `contributes.chatSkills`. */
export const DEFAULT_SKILLS = [
  'omnetpp-tooling',
  'omnetpp-model-development',
  'omnetpp-model-coding-conventions',
  'omnetpp-model-debugging',
];
/** Skills for model maintainers, installed only on request. */
export const OPTIONAL_SKILLS = [
  'omnetpp-model-fingerprint-testing',
  'omnetpp-model-refactoring',
  'omnetpp-model-review-brief',
  'omnetpp-model-git-workflow',
  'omnetpp-model-branch-cleanup',
  'omnetpp-model-branch-rebase',
];
/**
 * The non-default skills that each skill sends the agent to. They are installed with it,
 * so that no reference in an installed skill points to a skill the agent does not have.
 * The dev-* skills are generic procedures the omnetpp-model-* ones build on; they are
 * never offered on their own.
 */
export const SKILL_REQUIRES: Record<string, string[]> = {
  'omnetpp-model-fingerprint-testing': [],
  'omnetpp-model-refactoring': ['dev-commit-messages', 'dev-git-workflow', 'omnetpp-model-fingerprint-testing'],
  'omnetpp-model-review-brief': ['dev-commit-messages'],
  'omnetpp-model-git-workflow': [
    'dev-git-workflow',
    'omnetpp-model-fingerprint-testing',
    'omnetpp-model-branch-cleanup',
    'omnetpp-model-branch-rebase',
  ],
  'omnetpp-model-branch-cleanup': ['dev-branch-cleanup', 'omnetpp-model-branch-rebase'],
  'omnetpp-model-branch-rebase': ['dev-branch-rebase', 'omnetpp-model-branch-cleanup'],
  'dev-git-workflow': [
    'dev-branch-cleanup',
    'dev-branch-rebase',
    'dev-commit-messages',
    'dev-design',
    'omnetpp-model-git-workflow',
  ],
  'dev-commit-messages': [],
  'dev-branch-cleanup': ['dev-branch-rebase', 'dev-commit-messages', 'omnetpp-model-branch-cleanup'],
  'dev-branch-rebase': ['dev-branch-cleanup', 'dev-git-workflow', 'omnetpp-model-branch-rebase'],
  'dev-design': [],
};

/** The given optional skills plus every skill they require, transitively, in a stable order. */
export function withRequiredSkills(optionalSkills: readonly string[]): string[] {
  const result = new Set<string>();
  const visit = (name: string): void => {
    if (result.has(name)) return;
    result.add(name);
    for (const r of SKILL_REQUIRES[name] ?? []) visit(r);
  };
  for (const s of optionalSkills) if (OPTIONAL_SKILLS.includes(s)) visit(s);
  return Object.keys(SKILL_REQUIRES).filter((s) => result.has(s));
}

const DESCRIPTION =
  'OMNeT++ NED/MSG/INI support: lint feedback after edits, a NED/MSG/INI language server, and OMNeT++ modeling skills.';
const AUTHOR = { name: 'OpenSim Ltd.', url: 'https://omnetpp.org' };
/** The MCP server entry each agent registers; opp_ide_mcp indexes its working directory. */
export const MCP_SERVER = { name: PLUGIN_NAME, command: 'opp_ide_mcp', args: [] as string[] };

const HOOK_MATCHER = 'Edit|Write|MultiEdit|apply_patch';
const HOOK_COMMAND = 'opp_lint --agent-hook';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The generated files of the marketplace root, keyed by '/'-separated relative path.
 * Skill directories are not included: the caller copies the selected ones from the
 * bundled snapshot to `${PLUGIN_DIR}/skills/<name>/`.
 */
export function pluginFiles(version: string): Record<string, string> {
  const hooks = {
    hooks: {
      PostToolUse: [
        { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 120 }] },
      ],
    },
  };
  return {
    '.claude-plugin/marketplace.json': json({
      name: MARKETPLACE_NAME,
      owner: AUTHOR,
      description: 'OMNeT++ agent plugin installed by the OMNeT++ VS Code extension',
      plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_DIR}`, description: DESCRIPTION }],
    }),
    '.agents/plugins/marketplace.json': json({
      name: MARKETPLACE_NAME,
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: 'local', path: `./${PLUGIN_DIR}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Coding',
        },
      ],
    }),
    [`${PLUGIN_DIR}/.claude-plugin/plugin.json`]: json({
      name: PLUGIN_NAME,
      displayName: 'OMNeT++',
      version,
      description: DESCRIPTION,
      author: AUTHOR,
      homepage: 'https://omnetpp.org',
      keywords: ['omnetpp', 'ned', 'msg', 'ini', 'simulation'],
    }),
    [`${PLUGIN_DIR}/plugin.json`]: json({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: PLUGIN_NAME,
      version,
      description: DESCRIPTION,
      author: AUTHOR,
      homepage: 'https://omnetpp.org',
      keywords: ['omnetpp', 'ned', 'msg', 'ini', 'simulation'],
    }),
    [`${PLUGIN_DIR}/hooks/hooks.json`]: json(hooks),
    [`${PLUGIN_DIR}/hooks.json`]: json(hooks),
    [`${PLUGIN_DIR}/.lsp.json`]: json({
      [PLUGIN_NAME]: {
        command: 'opp_lsp',
        args: ['--stdio'],
        extensionToLanguage: { '.ned': 'ned', '.msg': 'msg', '.ini': 'ini' },
      },
    }),
  };
}
