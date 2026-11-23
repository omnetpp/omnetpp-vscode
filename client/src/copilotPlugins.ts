// Copilot in VS Code gets the OMNeT++ skills from the same marketplace as the agent CLIs,
// through VS Code's agent-plugin support (a preview since VS Code 1.110). VS Code reads
// the plugins' Agent Plugins manifest, which gives it the skills only: the MCP tools come
// from the extension's live bridge, and the language features from the extension itself.
// There is no API to install a plugin, so the extension adds the marketplace to the
// user's settings and opens VS Code's install page of each plugin, where the user
// confirms the install.
import * as vscode from 'vscode';
import { MARKETPLACE_SOURCE } from '@omnetpp/shared/agents';
import { claimOnce } from '@omnetpp/shared/node';
import { marketplaceSource, updatePluginState, type PluginState } from './agentPlugin';

const MANAGE_PLUGINS_COMMAND = 'workbench.action.chat.managePlugins';

export interface CopilotAvailability {
  available: boolean;
  reason?: string;
}

export async function copilotAvailability(): Promise<CopilotAvailability> {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(MANAGE_PLUGINS_COMMAND)) {
    return { available: false, reason: 'this VS Code has no agent plugins (needs VS Code 1.110 or newer)' };
  }
  if (!vscode.workspace.getConfiguration('chat').get<boolean>('plugins.enabled', true)) {
    return { available: false, reason: 'agent plugins are turned off (chat.plugins.enabled)' };
  }
  return { available: true };
}

/**
 * The marketplace as VS Code takes it: a GitHub `owner/repo[#ref]`. A local override is
 * for the agent CLIs only, because VS Code's install page does not accept local sources.
 */
export function copilotMarketplace(): string {
  const s = marketplaceSource();
  if (s.local) return MARKETPLACE_SOURCE;
  return s.ref ? `${s.location}#${s.ref}` : s.location;
}

/** Adds the marketplace to the user's chat.plugins.marketplaces, keeping the entries already there. */
async function addMarketplace(source: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('chat');
  // Not the effective value, which would copy workspace entries into the user settings; the
  // default, because a user value replaces it.
  const setting = config.inspect<string[]>('plugins.marketplaces');
  const current = setting?.globalValue ?? setting?.defaultValue ?? [];
  if (current.includes(source)) return;
  await config.update('plugins.marketplaces', [...current, source], vscode.ConfigurationTarget.Global);
}

/** Adds the marketplace and opens the install page of each plugin. Returns false when VS Code refused a step. */
export async function setUpCopilot(plugins: string[], log: vscode.LogOutputChannel): Promise<boolean> {
  const source = copilotMarketplace();
  try {
    await addMarketplace(source);
    log.info(`added ${source} to chat.plugins.marketplaces`);
  } catch (e) {
    log.error(`could not add ${source} to chat.plugins.marketplaces: ${(e as Error).message}`);
    return false;
  }
  let ok = true;
  for (const plugin of plugins) {
    const query = new URLSearchParams({ source, plugin }).toString();
    const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://chat-plugin/install?${query}`);
    log.info(`opening ${uri.toString(true)}`);
    if (!(await vscode.env.openExternal(uri))) {
      log.error(`VS Code did not open the install page of ${plugin}`);
      ok = false;
    }
  }
  return ok;
}

/**
 * Shown once: older extension versions gave Copilot the skills without any setup, and new
 * users would not know that Copilot needs one.
 */
export async function copilotNotice(context: vscode.ExtensionContext, state: PluginState | undefined): Promise<void> {
  if (state?.copilot || state?.copilotNoticeShown) return;
  if (!(await copilotAvailability()).available) return;
  if (!claimOnce(context.globalStorageUri.fsPath, 'copilot-notice')) return;
  await updatePluginState(context, (s) => ({ ...(s ?? { version: '', plugins: [], agents: [] }), copilotNoticeShown: true }));
  const setUp = 'Set Up';
  const answer = await vscode.window.showInformationMessage(
    'OMNeT++: Copilot gets the OMNeT++ skills from the "omnetpp" agent plugin marketplace. Set it up now?',
    setUp,
  );
  if (answer === setUp) await vscode.commands.executeCommand('omnetpp.setupAiAgents', { preselect: ['copilot'] });
}
