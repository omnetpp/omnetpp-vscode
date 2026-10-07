import { test } from 'bun:test';
import assert from 'node:assert';
import { parseJsonc } from '../project/jsonc';
import {
  BLOCK_BEGIN,
  BLOCK_END,
  agentsMdBlock,
  ensureClaudeImport,
  mergeExtensionRecommendations,
  mergeMarkerBlock,
} from '../agents/projectFiles';
import { DEFAULT_SKILLS, PLUGIN_DIR, pluginFiles } from '../agents/plugin';

const CLANGD = 'llvm-vs-code-extensions.vscode-clangd';
const facts = { nedRoots: ['src', 'simulations'], nedPathEntries: ['../inet/src'], iniFiles: ['simulations/omnetpp.ini'], hasMakefile: true };

test('agentsMdBlock names the project facts inside the markers', () => {
  const block = agentsMdBlock(facts);
  assert.ok(block.startsWith(BLOCK_BEGIN) && block.endsWith(BLOCK_END));
  assert.match(block, /NED source folders: `src`, `simulations`/);
  assert.match(block, /`\.\.\/inet\/src`/);
  assert.match(block, /`simulations\/omnetpp\.ini`/);
  assert.match(block, /make MODE=debug/);
  const bare = agentsMdBlock({ nedRoots: [], nedPathEntries: [], iniFiles: [], hasMakefile: false });
  assert.doesNotMatch(bare, /NED path|make|configurations:/);
});

test('agentsMdBlock caps the list of INI files', () => {
  const iniFiles = Array.from({ length: 13 }, (_, i) => `s${i}/omnetpp.ini`);
  assert.match(agentsMdBlock({ ...facts, iniFiles }), /`s9\/omnetpp\.ini` and 3 more/);
});

test('mergeMarkerBlock creates, appends, and replaces only the managed block', () => {
  const block = agentsMdBlock(facts);
  assert.equal(mergeMarkerBlock(undefined, block), `${block}\n`);
  const user = '# My project\n\nOwn notes.\n';
  const appended = mergeMarkerBlock(user, block);
  assert.equal(appended, `# My project\n\nOwn notes.\n\n${block}\n`);
  const newer = agentsMdBlock({ ...facts, nedRoots: ['.'] });
  const replaced = mergeMarkerBlock(`${appended}\n## After\n`, newer);
  assert.equal(replaced, `# My project\n\nOwn notes.\n\n${newer}\n\n## After\n`);
  assert.equal(mergeMarkerBlock(replaced, newer), replaced);
});

test('ensureClaudeImport adds @AGENTS.md once', () => {
  const once = ensureClaudeImport('# Rules\n');
  assert.equal(once, '# Rules\n\n@AGENTS.md\n');
  assert.equal(ensureClaudeImport(once), once);
  assert.equal(ensureClaudeImport('@AGENTS.md\n# Rules\n'), '@AGENTS.md\n# Rules\n');
});

test('mergeExtensionRecommendations creates the file or leaves a complete one alone', () => {
  assert.deepEqual(parseJsonc(mergeExtensionRecommendations(undefined, [CLANGD])!), { recommendations: [CLANGD] });
  const done = `{ "recommendations": ["${CLANGD.toUpperCase()}"] }`;
  assert.equal(mergeExtensionRecommendations(done, [CLANGD]), done);
});

test('mergeExtensionRecommendations inserts into an existing array and keeps comments', () => {
  const text = '{\n  // team picks\n  "recommendations": [\n    "ms-python.python", // py\n  ],\n  "unwantedRecommendations": []\n}\n';
  const merged = mergeExtensionRecommendations(text, [CLANGD])!;
  assert.match(merged, /\/\/ team picks/);
  assert.match(merged, /\/\/ py/);
  assert.deepEqual(parseJsonc(merged), { recommendations: ['ms-python.python', CLANGD], unwantedRecommendations: [] });
  assert.deepEqual(parseJsonc(mergeExtensionRecommendations('{ "recommendations": [] }', [CLANGD])!), { recommendations: [CLANGD] });
});

test('mergeExtensionRecommendations adds the key to an object without it', () => {
  assert.deepEqual(parseJsonc(mergeExtensionRecommendations('{}', [CLANGD])!), { recommendations: [CLANGD] });
  const other = mergeExtensionRecommendations('{\n  "unwantedRecommendations": ["x"] // no\n}', [CLANGD])!;
  assert.deepEqual(parseJsonc(other), { recommendations: [CLANGD], unwantedRecommendations: ['x'] });
});

test('mergeExtensionRecommendations refuses what it cannot edit safely', () => {
  assert.equal(mergeExtensionRecommendations('{ "recommendations": ', [CLANGD]), undefined);
  assert.equal(mergeExtensionRecommendations('[]', [CLANGD]), undefined);
  assert.equal(mergeExtensionRecommendations('{ "recommendations": "x" }', [CLANGD]), undefined);
});

test('pluginFiles gives every agent its manifest, the hook and the LSP server', () => {
  const files = pluginFiles('1.2.3');
  const read = (p: string) => JSON.parse(files[p]);
  assert.equal(read('.claude-plugin/marketplace.json').plugins[0].source, `./${PLUGIN_DIR}`);
  assert.deepEqual(read('.agents/plugins/marketplace.json').plugins[0].source, { source: 'local', path: `./${PLUGIN_DIR}` });
  assert.equal(read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`).version, '1.2.3');
  assert.equal(read(`${PLUGIN_DIR}/plugin.json`).version, '1.2.3');
  for (const p of [`${PLUGIN_DIR}/hooks/hooks.json`, `${PLUGIN_DIR}/hooks.json`]) {
    const hook = read(p).hooks.PostToolUse[0];
    assert.equal(hook.hooks[0].command, 'opp_lint --agent-hook');
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'apply_patch']) assert.match(tool, new RegExp(`^(${hook.matcher})$`));
  }
  assert.deepEqual(Object.keys(read(`${PLUGIN_DIR}/.lsp.json`).omnetpp.extensionToLanguage), ['.ned', '.msg', '.ini']);
  assert.ok(!Object.keys(files).some((p) => /mcp\.json$/.test(p)), 'the MCP server is registered per agent, not in the plugin');
  assert.ok(DEFAULT_SKILLS.includes('omnetpp-tooling'));
});
