// "OMNeT++: Set Up AI Agents…": installs the OMNeT++ agent plugin (skills, lint hook,
// language server) and the MCP server into the selected agent CLIs, and writes the
// project files that describe the project to any agent (AGENTS.md) and recommend
// the clangd C++ extension. Copilot in VS Code needs none of this: it gets the
// skills through contributes.chatSkills and the tools through the live MCP bridge.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { OmnetppMethods, type ProjectFactsResult } from '@omnetpp/shared/protocol';
import {
  OPTIONAL_SKILLS,
  agentsMdBlock,
  ensureClaudeImport,
  mergeExtensionRecommendations,
  mergeMarkerBlock,
  parseJsonc,
  type ProjectFacts,
} from '@omnetpp/shared/agents';
import { ensureCliTools } from './cliTools';
import {
  type AgentId,
  agentLog,
  pluginState,
  probeAgents,
  runSteps,
  savePluginState,
  writePlugin,
} from './agentPlugin';

const CLANGD = 'llvm-vs-code-extensions.vscode-clangd';
const SKILL_LABELS: Record<string, string> = {
  'omnetpp-fingerprint-testing': 'Fingerprint testing skill',
  'omnetpp-model-refactoring': 'Model refactoring skill',
};

interface FileChange {
  uri: vscode.Uri;
  text: string;
  created: boolean;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Project folder to set up for AI agents' });
}

function splitNedPath(value: string): string[] {
  return value
    .split(process.platform === 'win32' ? ';' : /[;:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** `p` relative to `dir` ('.' for `dir` itself), or undefined when it lies outside. */
function inside(dir: string, p: string): string | undefined {
  const rel = path.relative(dir, p);
  if (rel === '') return '.';
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return undefined;
  return toPosix(rel);
}

async function indexFacts(client: LanguageClient): Promise<ProjectFactsResult> {
  // The index may still be scanning right after startup.
  for (let i = 0; ; i++) {
    const r = await client.sendRequest<ProjectFactsResult>(OmnetppMethods.projectFacts);
    if (r.ready || i >= 60) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
}

interface Facts {
  facts: ProjectFacts;
  warnings: string[];
}

async function projectFacts(client: LanguageClient, folder: vscode.WorkspaceFolder): Promise<Facts> {
  const dir = folder.uri.fsPath;
  const r = await indexFacts(client);
  const nedRoots = [...new Set(r.nedRoots.map((p) => inside(dir, p)).filter((p): p is string => !!p))].sort();
  const iniFiles = r.iniFiles
    .map((u) => inside(dir, vscode.Uri.parse(u).fsPath))
    .filter((p): p is string => !!p)
    .sort();

  // The command-line tools and agents read the NED path only from the folder's own settings file.
  const warnings: string[] = [];
  const settings = await readText(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json'));
  let fileValue = '';
  try {
    const v = settings ? (parseJsonc(settings) as Record<string, unknown>)['omnetpp.nedPath'] : undefined;
    if (typeof v === 'string') fileValue = v;
  } catch {
    warnings.push('.vscode/settings.json could not be parsed, so its omnetpp.nedPath is not known.');
  }
  const effective = vscode.workspace.getConfiguration('omnetpp', folder.uri).get<string>('nedPath', '');
  if (effective && !fileValue) {
    warnings.push(
      'omnetpp.nedPath is set outside this folder\'s .vscode/settings.json (user or workspace settings). ' +
        'The command-line tools and AI agents do not see it; move it to the folder settings.',
    );
  }
  const nedPathEntries = splitNedPath(fileValue);
  const absolute = nedPathEntries.filter((e) => path.isAbsolute(e));
  if (absolute.length) {
    warnings.push(
      `omnetpp.nedPath contains absolute paths (${absolute.join(', ')}). They do not work for teammates; ` +
        'prefer paths relative to the project folder.',
    );
  }
  const hasMakefile = (await readText(vscode.Uri.joinPath(folder.uri, 'Makefile'))) !== undefined;
  return { facts: { nedRoots, nedPathEntries, iniFiles, hasMakefile }, warnings };
}

async function plannedChanges(
  folder: vscode.WorkspaceFolder,
  facts: ProjectFacts,
  writeAgentsMd: boolean,
  recommendClangd: boolean,
  warnings: string[],
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const add = async (uri: vscode.Uri, update: (old: string | undefined) => string | undefined, what: string) => {
    const old = await readText(uri);
    const text = update(old);
    if (text === undefined) warnings.push(`${what} was left unchanged: it is not valid JSON.`);
    else if (text !== old) changes.push({ uri, text, created: old === undefined });
  };
  if (writeAgentsMd) {
    await add(vscode.Uri.joinPath(folder.uri, 'AGENTS.md'), (old) => mergeMarkerBlock(old, agentsMdBlock(facts)), 'AGENTS.md');
    // Claude reads AGENTS.md by itself only when there is no CLAUDE.md, so never create one.
    const claudeMd = vscode.Uri.joinPath(folder.uri, 'CLAUDE.md');
    if ((await readText(claudeMd)) !== undefined) await add(claudeMd, (old) => ensureClaudeImport(old ?? ''), 'CLAUDE.md');
  }
  if (recommendClangd) {
    await add(
      vscode.Uri.joinPath(folder.uri, '.vscode', 'extensions.json'),
      (old) => mergeExtensionRecommendations(old, [CLANGD]),
      '.vscode/extensions.json',
    );
  }
  return changes;
}

async function setUpAiAgents(context: vscode.ExtensionContext, client: LanguageClient): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    void vscode.window.showErrorMessage('OMNeT++: open a project folder first.');
    return;
  }
  const tools = await ensureCliTools(context);
  if (!tools) return;

  const availability = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'OMNeT++: looking for AI agent CLIs…' },
    () => probeAgents(),
  );
  type AgentItem = vscode.QuickPickItem & { id?: AgentId };
  const agentItems: AgentItem[] = availability
    .filter((a) => a.available)
    .map((a) => ({ label: a.cli.label, description: a.cli.exe, id: a.cli.id, picked: true }));
  const unavailable = availability.filter((a) => !a.available);
  for (const a of unavailable) agentLog().info(`${a.cli.label} is not available: ${a.reason}`);
  if (unavailable.length) {
    agentItems.push({ label: 'Not available', kind: vscode.QuickPickItemKind.Separator });
    for (const a of unavailable) agentItems.push({ label: `$(circle-slash) ${a.cli.label}`, description: a.reason });
  }
  const pickedAgents = await vscode.window.showQuickPick(agentItems, {
    canPickMany: true,
    title: 'Set Up AI Agents (1/2): agents to install the OMNeT++ plugin and MCP server into',
    placeHolder: 'Copilot in VS Code needs no setup. Pick none to write only the project files.',
  });
  if (!pickedAgents) return;
  const agents = availability.filter((a) => a.available && pickedAgents.some((p) => p.id === a.cli.id)).map((a) => a.cli);

  const previous = pluginState(context);
  type OptionItem = vscode.QuickPickItem & { key: string };
  const optionItems: OptionItem[] = [
    { key: 'agentsMd', label: 'Describe the project in AGENTS.md', detail: 'A managed section that every agent reads; your own text stays.', picked: true },
    { key: 'clangd', label: 'Recommend the clangd C++ extension', detail: 'In .vscode/extensions.json; clangd needs a compile_commands.json.', picked: true },
    ...OPTIONAL_SKILLS.map((s) => ({
      key: s,
      label: SKILL_LABELS[s] ?? s,
      description: 'optional skill, for all projects',
      picked: previous?.optionalSkills.includes(s) ?? false,
    })),
  ];
  const options = await vscode.window.showQuickPick(optionItems, {
    canPickMany: true,
    title: 'Set Up AI Agents (2/2): project files and optional skills',
  });
  if (!options) return;
  const chosen = new Set(options.map((o) => o.key));
  const optionalSkills = OPTIONAL_SKILLS.filter((s) => chosen.has(s));

  const { facts, warnings } = await projectFacts(client, folder);
  const changes = await plannedChanges(folder, facts, chosen.has('agentsMd'), chosen.has('clangd'), warnings);

  const lines = [
    ...changes.map((c) => `${c.created ? 'Create' : 'Update'} ${toPosix(path.relative(folder.uri.fsPath, c.uri.fsPath))}`),
    ...agents.map((a) => `Install the OMNeT++ plugin and MCP server into ${a.label} (user level)`),
  ];
  if (!lines.length) {
    void vscode.window.showInformationMessage('OMNeT++: nothing to do — the project files are up to date and no agent was selected.');
    return;
  }
  const go = await vscode.window.showInformationMessage(
    `Set up "${folder.name}" for AI agents?`,
    { modal: true, detail: lines.join('\n') },
    'Set Up',
  );
  if (go !== 'Set Up') return;

  for (const c of changes) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(c.uri, '..'));
    await vscode.workspace.fs.writeFile(c.uri, new TextEncoder().encode(c.text));
  }

  const log = agentLog();
  const ok: AgentId[] = [];
  const failed: string[] = [];
  if (agents.length) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'OMNeT++: setting up AI agents' },
      async (progress) => {
        let root: string;
        try {
          root = writePlugin(context, optionalSkills);
        } catch (e) {
          log.error(`could not write the agent plugin: ${(e as Error).message}`);
          failed.push(...agents.map((a) => a.label));
          return;
        }
        log.info(`agent plugin written to ${root}`);
        for (const cli of agents) {
          progress.report({ message: cli.label });
          if (await runSteps(cli, cli.install(root), log)) ok.push(cli.id);
          else failed.push(cli.label);
        }
      },
    );
  }
  await savePluginState(context, {
    version: (context.extension.packageJSON as { version: string }).version,
    optionalSkills,
    agents: [...new Set([...(previous?.agents ?? []), ...ok])],
  });

  if (!tools.onPath) warnings.push(`${tools.binDir} is not on PATH, so agents cannot start opp_lint, opp_lsp and opp_ide_mcp. Add it to PATH.`);
  if (ok.includes('codex')) warnings.push('Codex runs the plugin\'s lint hook only after you trust it: run /hooks in Codex once.');
  const hints = [
    'Restart running agent sessions so that they load the plugin and the MCP server.',
    'clangd needs a compile_commands.json: for example "bear -- make -B MODE=debug" in the project folder.',
  ];
  if (ok.includes('claude')) hints.push('For C++ intelligence in Claude Code: /plugin install clangd-lsp@claude-plugins-official');
  for (const w of warnings) log.warn(w);
  for (const h of hints) log.info(h);

  const summary = [
    changes.length ? `wrote ${changes.length} project file(s)` : undefined,
    ok.length ? `set up ${ok.length} agent(s)` : undefined,
  ].filter(Boolean);
  const message = `OMNeT++: ${summary.join(', ') || 'done'}${failed.length ? `; failed for ${failed.join(', ')}` : ''}.`;
  const show = 'Show Details';
  const answer = await (failed.length || warnings.length
    ? vscode.window.showWarningMessage(`${message} ${warnings[0] ?? ''}`.trim(), show)
    : vscode.window.showInformationMessage(message, show));
  if (answer === show) log.show(true);
}

export function registerAgentSetupCommand(context: vscode.ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.setupAiAgents', () => setUpAiAgents(context, client)),
  );
}
