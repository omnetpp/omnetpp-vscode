// The JSON that agent post-edit hooks send on stdin names the edited files in
// different ways: Claude's Edit/Write/MultiEdit give `tool_input.file_path`, Copilot
// CLI's edit/create give `path` (in `toolArgs`, often a JSON string, in its own
// camelCase input), and Codex reports every edit as `apply_patch` with the patch text,
// whose `*** Update File: <path>` headers name the files. Cursor does not document the
// `tool_input` of its Write tool; `file_path` and `path` are the likely names.

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;
const PATCH_START = '*** Begin Patch';
const PATH_KEYS = new Set(['file_path', 'path']);

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {};
}

function patchFiles(patch: string): string[] {
  return [...patch.matchAll(PATCH_FILE)].map((m) => m[1].trim());
}

/** Paths of the files an edit tool wrote, as given (possibly relative to the hook's `cwd`).
 *  Files deleted by a patch are not included. */
export function editedFiles(hookInput: unknown): string[] {
  const h = asObject(hookInput);
  let toolInput = h.tool_input ?? h.toolArgs;
  if (typeof toolInput === 'string') {
    if (toolInput.includes(PATCH_START)) return [...new Set(patchFiles(toolInput))];
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(asObject(toolInput))) {
    if (typeof value !== 'string') continue;
    if (PATH_KEYS.has(key)) out.push(value);
    else if (value.includes(PATCH_START)) out.push(...patchFiles(value));
  }
  return [...new Set(out)];
}

/** How a hook's report reaches the model. `claude` is also the contract of Codex and Devin. */
export type HookAgent = 'claude' | 'copilot' | 'cursor';
export const HOOK_AGENTS: readonly HookAgent[] = ['claude', 'copilot', 'cursor'];

/** Copilot CLI sets CLAUDE_PROJECT_DIR and CLAUDE_PLUGIN_ROOT too, and Cursor sets
 *  CLAUDE_PROJECT_DIR, so the agent is told by what only it sends. */
export function hookAgent(hookInput: unknown, env: Record<string, string | undefined>): HookAgent {
  const h = asObject(hookInput);
  if (typeof h.cursor_version === 'string') return 'cursor';
  const result = asObject(h.tool_result);
  if (env.COPILOT_PLUGIN_ROOT || 'toolName' in h || 'toolArgs' in h || 'result_type' in result || 'text_result_for_llm' in result) {
    return 'copilot';
  }
  return 'claude';
}

/** The project the edit belongs to. Cursor may send an empty `cwd`. */
export function hookProjectDir(hookInput: unknown, env: Record<string, string | undefined>): string | undefined {
  const h = asObject(hookInput);
  const roots = Array.isArray(h.workspace_roots) ? h.workspace_roots : [];
  const candidates = [env.CLAUDE_PROJECT_DIR, env.CURSOR_PROJECT_DIR, roots[0], h.cwd];
  return candidates.find((c): c is string => typeof c === 'string' && c !== '');
}

/** Copilot CLI caps additionalContext at 10 KB. */
export const COPILOT_CONTEXT_LIMIT = 10_000;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function capLines(report: string, limit: number): string {
  if (byteLength(report) <= limit) return report;
  const lines = report.trimEnd().split('\n');
  const trailer = (n: number) => `… ${n} more line${n === 1 ? '' : 's'} not shown\n`;
  let kept = lines.length;
  let size = byteLength(lines.join('\n')) + 1;
  while (kept > 0 && size + byteLength(trailer(lines.length - kept)) > limit) {
    kept--;
    size -= byteLength(lines[kept]) + 1;
  }
  return `${lines.slice(0, kept).join('\n')}\n${trailer(lines.length - kept)}`;
}

export interface HookReply {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Claude Code, Codex and Devin show the stderr of an exit-2 PostToolUse hook to the
 *  model; Copilot CLI shows it only to the user, so Copilot and Cursor get a JSON
 *  context field on stdout instead. */
export function hookReply(agent: HookAgent, report: string): HookReply {
  if (agent === 'copilot') {
    const additionalContext = capLines(report, COPILOT_CONTEXT_LIMIT);
    return { stdout: `${JSON.stringify({ additionalContext })}\n`, stderr: '', exitCode: 0 };
  }
  if (agent === 'cursor') return { stdout: `${JSON.stringify({ additional_context: report })}\n`, stderr: '', exitCode: 0 };
  return { stdout: '', stderr: report, exitCode: 2 };
}
